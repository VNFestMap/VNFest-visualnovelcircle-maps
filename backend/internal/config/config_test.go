package config

import "testing"

func TestValidateProduction(t *testing.T) {
	valid := Config{
		Environment: "production", DBDriver: "mysql", DBHost: "db", DBName: "vnfest", DBUser: "vnfest",
		SiteURL: "https://map.example", SessionSecret: "session-secret", AdminToken: "admin-token",
		RecognitionHMACSecret: "recognition-secret", MailDriver: "mail",
	}
	if err := valid.ValidateProduction(); err != nil {
		t.Fatalf("valid production configuration rejected: %v", err)
	}
	valid.PicUIEnabled = true
	if err := valid.ValidateProduction(); err == nil {
		t.Fatal("enabled PicUI without token should be rejected")
	}
	valid.PicUIToken = "picui-token"
	if err := valid.ValidateProduction(); err != nil {
		t.Fatalf("complete production configuration rejected: %v", err)
	}
}

func TestValidateProductionDoesNotApplyToDevelopment(t *testing.T) {
	if err := (Config{Environment: "development", DBDriver: "sqlite"}).ValidateProduction(); err != nil {
		t.Fatalf("development configuration should not require production secrets: %v", err)
	}
}
