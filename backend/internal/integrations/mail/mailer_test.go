package mail

import (
	"io"
	"mime"
	stdmail "net/mail"
	"strings"
	"testing"
)

func TestEncodedMessagePreservesVerificationCode(t *testing.T) {
	mailer := New(Config{FromName: "VNFest（视觉小说学园祭）", FromAddr: "authentication@example.com"})
	for _, subject := range []string{"社交账号登录验证码", "邮箱验证码", "密码找回验证码"} {
		for _, newline := range []string{"\n", "\r\n"} {
			t.Run(subject+newline, func(t *testing.T) {
				body := "您的验证码是：012345" + newline + newline + "验证码 5 分钟内有效。如果不是您本人操作，请忽略此邮件。" + newline
				encoded := mailer.encodeMessage(Message{To: "reader@example.com", Subject: subject, Body: body})
				parsed, err := stdmail.ReadMessage(strings.NewReader(encoded))
				if err != nil {
					t.Fatalf("parse mail: %v", err)
				}
				decodedSubject, err := new(mime.WordDecoder).DecodeHeader(parsed.Header.Get("Subject"))
				if err != nil || decodedSubject != subject {
					t.Fatalf("subject = %q, error = %v", decodedSubject, err)
				}
				got, err := io.ReadAll(parsed.Body)
				if err != nil {
					t.Fatal(err)
				}
				want := strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n") + "\r\n"
				if string(got) != want {
					t.Fatalf("parsed body = %q, want %q", got, want)
				}
				if strings.Contains(strings.ReplaceAll(encoded, "\r\n", ""), "\n") {
					t.Fatal("mail contains bare LF")
				}
			})
		}
	}
}
