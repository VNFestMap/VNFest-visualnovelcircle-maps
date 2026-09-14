package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBangumiImageNormalizationSupportsV0ImagesAndExistingProxyPaths(t *testing.T) {
	const image = "https://lain.bgm.tv/pic/crt/m/12/34/5678_crt.jpg"
	const legacyImage = "http://lain.bgm.tv/pic/cover/m/64/67/6312_7o94P.jpg"
	proxy := "/api/image_proxy.php?url=https%3A%2F%2Flain.bgm.tv%2Fpic%2Fcrt%2Fm%2F12%2F34%2F5678_crt.jpg"
	legacyProxy := "/api/image_proxy.php?url=https%3A%2F%2Flain.bgm.tv%2Fpic%2Fcover%2Fm%2F64%2F67%2F6312_7o94P.jpg"

	characterPayload, err := json.Marshal(map[string]any{
		"data": []any{map[string]any{"id": 7, "name": "Character", "name_cn": "角色", "images": map[string]any{"medium": image}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	characters := normalizeBangumiCharacters(characterPayload)
	if len(characters) != 1 || characters[0]["image_url"] != proxy {
		t.Fatalf("character image normalization = %#v, want %q", characters, proxy)
	}

	legacyPayload, err := json.Marshal(map[string]any{
		"list": []any{map[string]any{"id": 8, "name": "Work", "name_cn": "作品", "images": map[string]any{"large": image}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	works := normalizeBangumiLegacySearch(legacyPayload)
	if len(works) != 1 || works[0]["image_url"] != proxy {
		t.Fatalf("legacy work image normalization = %#v, want %q", works, proxy)
	}

	legacyHTTPPayload, err := json.Marshal(map[string]any{
		"list": []any{map[string]any{"id": 9, "name": "Legacy Work", "images": map[string]any{"medium": legacyImage}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	legacyWorks := normalizeBangumiLegacySearch(legacyHTTPPayload)
	if len(legacyWorks) != 1 || legacyWorks[0]["image_url"] != legacyProxy {
		t.Fatalf("legacy HTTP work image normalization = %#v, want %q", legacyWorks, legacyProxy)
	}

	if got := bangumiProxyImageURL(proxy); got != proxy {
		t.Fatalf("existing proxy path was not preserved: got %q", got)
	}
	if !strings.HasPrefix(bangumiProxyImageURL(image), "/api/image_proxy.php?url=") {
		t.Fatalf("raw Bangumi image was not proxied")
	}
	if got := bangumiProxyImageURL(legacyImage); got != legacyProxy {
		t.Fatalf("legacy HTTP Bangumi image was not normalized: got %q, want %q", got, legacyProxy)
	}
}
