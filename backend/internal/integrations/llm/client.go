package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrUnavailable = errors.New("llm unavailable")

type Config struct {
	Enabled     bool
	Provider    string
	APIKey      string
	APIURL      string
	Proxy       string
	Model       string
	MaxTokens   int
	Temperature float64
}

type Client struct {
	cfg    Config
	client *http.Client
}

func New(cfg Config) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if strings.TrimSpace(cfg.Proxy) != "" {
		if proxyURL, err := url.Parse(strings.TrimSpace(cfg.Proxy)); err == nil && proxyURL.Scheme != "" && proxyURL.Host != "" {
			transport.Proxy = http.ProxyURL(proxyURL)
		}
	}
	return &Client{cfg: cfg, client: &http.Client{Transport: transport, Timeout: 35 * time.Second}}
}

// Chat sends one structured prompt and extracts the JSON object returned by
// OpenAI-compatible or Claude-compatible APIs. Response bodies are bounded so
// a faulty upstream cannot exhaust the Go process memory.
func (c *Client) Chat(ctx context.Context, systemPrompt, userPrompt string) (map[string]any, error) {
	if !c.cfg.Enabled || strings.TrimSpace(c.cfg.APIKey) == "" || strings.TrimSpace(c.cfg.APIURL) == "" {
		return nil, ErrUnavailable
	}
	provider := strings.ToLower(strings.TrimSpace(c.cfg.Provider))
	var payload map[string]any
	if provider == "claude" {
		payload = map[string]any{
			"model": c.cfg.Model, "max_tokens": c.cfg.MaxTokens, "temperature": c.cfg.Temperature,
			"system":   systemPrompt,
			"messages": []map[string]string{{"role": "user", "content": userPrompt}},
		}
	} else {
		payload = map[string]any{
			"model": c.cfg.Model, "max_tokens": c.cfg.MaxTokens, "temperature": c.cfg.Temperature,
			"messages":        []map[string]string{{"role": "system", "content": systemPrompt}, {"role": "user", "content": userPrompt}},
			"response_format": map[string]string{"type": "json_object"},
		}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal llm request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.APIURL, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("build llm request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if provider == "claude" {
		request.Header.Set("x-api-key", c.cfg.APIKey)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("llm transport: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20+1))
	if err != nil {
		return nil, fmt.Errorf("read llm response: %w", err)
	}
	if len(body) > 2<<20 {
		return nil, errors.New("llm response too large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("llm upstream status %d", response.StatusCode)
	}
	content, err := responseContent(provider, body)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if json.Unmarshal([]byte(content), &result) == nil && result != nil {
		return result, nil
	}
	trimmed := strings.TrimSpace(content)
	if strings.HasPrefix(trimmed, "```") {
		if index := strings.Index(trimmed, "\n"); index >= 0 {
			trimmed = strings.TrimSpace(trimmed[index+1:])
		}
		trimmed = strings.TrimSuffix(trimmed, "```")
		if json.Unmarshal([]byte(strings.TrimSpace(trimmed)), &result) == nil && result != nil {
			return result, nil
		}
	}
	return nil, errors.New("llm response is not valid JSON")
}

func responseContent(provider string, body []byte) (string, error) {
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", errors.New("llm response JSON decode failed")
	}
	if provider == "claude" {
		for _, item := range anySlice(envelope["content"]) {
			if row, ok := item.(map[string]any); ok && stringValue(row["type"]) == "text" {
				return stringValue(row["text"]), nil
			}
		}
		return "", errors.New("llm response content missing")
	}
	choices := anySlice(envelope["choices"])
	if len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if message, ok := choice["message"].(map[string]any); ok {
				return stringValue(message["content"]), nil
			}
		}
	}
	return "", errors.New("llm response content missing")
}

func anySlice(value any) []any {
	if result, ok := value.([]any); ok {
		return result
	}
	return nil
}

func stringValue(value any) string {
	if result, ok := value.(string); ok {
		return result
	}
	return ""
}
