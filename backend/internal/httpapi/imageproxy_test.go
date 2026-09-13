package httpapi

import "testing"

func TestAllowedImageURLRejectsSSRF(t *testing.T) {
	allowed := []string{
		"https://lain.bgm.tv/pic/cover/l/12/34/5678.jpg",
		"https://t.vndb.org/v/12/345.jpg",
		"https://image.cngal.org/images/a/b.png",
		"https://media.st.dl.eccdnx.com/steam/apps/1669980/header.jpg",
	}
	for _, raw := range allowed {
		if _, ok := allowedImageURL(raw); !ok {
			t.Errorf("expected allowed image URL: %s", raw)
		}
	}
	for _, raw := range []string{
		"http://127.0.0.1/admin",
		"https://example.com/image.png",
		"https://t.vndb.org/redirect?to=http://127.0.0.1",
		"https://t.vndb.org/%2e%2e/%2e%2e/etc/passwd",
		"https://user:pass@t.vndb.org/v/12/345.jpg",
		"https://media.st.dl.eccdnx.com/assets/header.jpg",
	} {
		if _, ok := allowedImageURL(raw); ok {
			t.Errorf("expected rejected image URL: %s", raw)
		}
	}
}

func TestImageContentType(t *testing.T) {
	checks := []struct {
		name string
		data []byte
		want string
	}{
		{"png", []byte("\x89PNG\r\n\x1a\n"), "image/png"},
		{"jpeg", []byte{0xff, 0xd8, 0xff}, "image/jpeg"},
		{"gif", []byte("GIF89a"), "image/gif"},
		{"webp", []byte("RIFFxxxxWEBP"), "image/webp"},
	}
	for _, check := range checks {
		if got := imageContentType(check.data); got != check.want {
			t.Errorf("%s: got %q, want %q", check.name, got, check.want)
		}
	}
}

func TestImageProxyFetchURLsSupportsCnGalWrapperFallback(t *testing.T) {
	raw := "https://tucang.cngal.top/api/image/show/90e7020e86b6c8ea27e59753c8149ee9?https://image.cngal.org/images/2022/01/05/a67a7c075875.png"
	parsed, ok := allowedImageURL(raw)
	if !ok {
		t.Fatalf("expected CnGal wrapper URL to be allowed")
	}

	candidates := imageProxyFetchURLs(raw, parsed)
	if len(candidates) != 2 {
		t.Fatalf("expected wrapper and original candidates, got %d: %v", len(candidates), candidates)
	}
	if candidates[0] != raw {
		t.Fatalf("first candidate should preserve the wrapper URL, got %q", candidates[0])
	}
	if candidates[1] != "https://image.cngal.org/images/2022/01/05/a67a7c075875.png" {
		t.Fatalf("unexpected CnGal original fallback: %q", candidates[1])
	}
}

func TestImageProxyFetchURLsSupportsCnGalSteamFallback(t *testing.T) {
	raw := "https://tucang.cngal.top/api/image/show/9e1e38ed31892314381ef77c0e106ce6?https://media.st.dl.eccdnx.com/steam/apps/1669980/header.jpg"
	parsed, ok := allowedImageURL(raw)
	if !ok {
		t.Fatalf("expected CnGal wrapper URL with Steam origin to be allowed")
	}

	candidates := imageProxyFetchURLs(raw, parsed)
	if len(candidates) != 2 {
		t.Fatalf("expected wrapper and Steam origin candidates, got %d: %v", len(candidates), candidates)
	}
	if candidates[1] != "https://media.st.dl.eccdnx.com/steam/apps/1669980/header.jpg" {
		t.Fatalf("unexpected CnGal Steam original fallback: %q", candidates[1])
	}
}

func TestImageProxyFetchURLsUpgradesLegacyBangumiHTTP(t *testing.T) {
	raw := "http://lain.bgm.tv/pic/cover/m/16/3a/233030_422zH.jpg"
	parsed, ok := allowedImageURL(raw)
	if !ok {
		t.Fatalf("expected legacy Bangumi URL to be allowed")
	}

	candidates := imageProxyFetchURLs(raw, parsed)
	if len(candidates) != 2 {
		t.Fatalf("expected HTTPS and legacy candidates, got %d: %v", len(candidates), candidates)
	}
	if candidates[0] != "https://lain.bgm.tv/pic/cover/m/16/3a/233030_422zH.jpg" {
		t.Fatalf("expected HTTPS-first candidate, got %q", candidates[0])
	}
	if candidates[1] != raw {
		t.Fatalf("expected legacy URL as second candidate, got %q", candidates[1])
	}
}
