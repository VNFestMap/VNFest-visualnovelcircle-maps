package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"os/exec"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/domain"
)

// Message is deliberately small so handlers do not know about SMTP details.
type Message = domain.Message

type Config struct {
	Driver     string
	FromName   string
	FromAddr   string
	SMTPHost   string
	SMTPPort   int
	SMTPUser   string
	SMTPPass   string
	SMTPSecure string
}

type Mailer struct{ cfg Config }

var _ domain.Mailer = (*Mailer)(nil)

func New(cfg Config) *Mailer { return &Mailer{cfg: cfg} }

func (m *Mailer) Send(ctx context.Context, message Message) error {
	to := strings.TrimSpace(message.To)
	if to == "" || !strings.Contains(to, "@") {
		return errors.New("invalid recipient")
	}
	if strings.TrimSpace(message.Subject) == "" || message.Body == "" {
		return errors.New("mail subject and body are required")
	}
	switch strings.ToLower(strings.TrimSpace(m.cfg.Driver)) {
	case "smtp":
		return m.sendSMTP(ctx, message)
	case "mail", "sendmail":
		return m.sendSendmail(ctx, message)
	default:
		return fmt.Errorf("unsupported mail driver %q", m.cfg.Driver)
	}
}

func (m *Mailer) sendSendmail(ctx context.Context, message Message) error {
	from := m.cfg.FromAddr
	if from == "" {
		from = "noreply@localhost"
	}
	// Keep the native fallback useful on Linux deployments and harmless on
	// Windows development machines where sendmail is normally absent.
	cmd := exec.CommandContext(ctx, "sendmail", "-f", from, message.To)
	cmd.Stdin = strings.NewReader(m.headers(message) + "\r\n" + message.Body + "\r\n")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sendmail failed: %w", err)
	}
	return nil
}

func (m *Mailer) sendSMTP(ctx context.Context, message Message) error {
	if m.cfg.SMTPHost == "" || m.cfg.SMTPUser == "" || m.cfg.SMTPPass == "" {
		return errors.New("SMTP configuration is incomplete")
	}
	port := m.cfg.SMTPPort
	if port == 0 {
		port = 465
	}
	address := net.JoinHostPort(m.cfg.SMTPHost, fmt.Sprint(port))
	secure := strings.ToLower(strings.TrimSpace(m.cfg.SMTPSecure))
	var client *smtp.Client
	var conn net.Conn
	var err error
	if secure == "ssl" || (secure == "" && port == 465) {
		conn, err = (&tls.Dialer{NetDialer: &net.Dialer{Timeout: 10 * time.Second}, Config: &tls.Config{ServerName: m.cfg.SMTPHost, MinVersion: tls.VersionTLS12}}).DialContext(ctx, "tcp", address)
		if err == nil {
			_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
			client, err = smtp.NewClient(conn, m.cfg.SMTPHost)
		}
	} else {
		conn, err = (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", address)
		if err == nil {
			_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
			client, err = smtp.NewClient(conn, m.cfg.SMTPHost)
		}
		if err == nil && secure == "tls" {
			if ok, _ := client.Extension("STARTTLS"); !ok {
				err = errors.New("SMTP server does not support STARTTLS")
			} else {
				err = client.StartTLS(&tls.Config{ServerName: m.cfg.SMTPHost, MinVersion: tls.VersionTLS12})
			}
		}
	}
	if err != nil {
		if conn != nil {
			_ = conn.Close()
		}
		return fmt.Errorf("SMTP connection failed: %w", err)
	}
	defer client.Close()
	auth := smtp.PlainAuth("", m.cfg.SMTPUser, m.cfg.SMTPPass, m.cfg.SMTPHost)
	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP authentication failed: %w", err)
	}
	from := m.cfg.FromAddr
	if from == "" {
		from = m.cfg.SMTPUser
	}
	if err := client.Mail(from); err != nil {
		return fmt.Errorf("SMTP sender rejected: %w", err)
	}
	if err := client.Rcpt(message.To); err != nil {
		return fmt.Errorf("SMTP recipient rejected: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA failed: %w", err)
	}
	if _, err = writer.Write([]byte(m.headers(message) + "\r\n" + message.Body + "\r\n")); err != nil {
		_ = writer.Close()
		return fmt.Errorf("SMTP body failed: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("SMTP send failed: %w", err)
	}
	return client.Quit()
}

func (m *Mailer) headers(message Message) string {
	from := m.cfg.FromAddr
	if from == "" {
		from = "noreply@localhost"
	}
	fromName := m.cfg.FromName
	if fromName == "" {
		fromName = "地图"
	}
	return "From: " + mimeHeader(fromName) + " <" + from + ">\r\n" +
		"To: <" + message.To + ">\r\n" +
		"Subject: " + mimeHeader(message.Subject) + "\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n" +
		"MIME-Version: 1.0"
}

func mimeHeader(value string) string {
	if value == "" {
		return ""
	}
	return "=?UTF-8?B?" + base64Encode([]byte(value)) + "?="
}

// Kept local to avoid exposing encoding helpers outside this integration.
func base64Encode(value []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	var out strings.Builder
	for i := 0; i < len(value); i += 3 {
		var n uint32
		remaining := len(value) - i
		n = uint32(value[i]) << 16
		if remaining > 1 {
			n |= uint32(value[i+1]) << 8
		}
		if remaining > 2 {
			n |= uint32(value[i+2])
		}
		out.WriteByte(alphabet[(n>>18)&63])
		out.WriteByte(alphabet[(n>>12)&63])
		if remaining > 1 {
			out.WriteByte(alphabet[(n>>6)&63])
		} else {
			out.WriteByte('=')
		}
		if remaining > 2 {
			out.WriteByte(alphabet[n&63])
		} else {
			out.WriteByte('=')
		}
	}
	return out.String()
}
