package httpapi

import "testing"

func TestDatabaseValueStringConvertsNotificationTextBytes(t *testing.T) {
	if got := databaseValueString([]byte("通知正文：中文")); got != "通知正文：中文" {
		t.Fatalf("database byte text = %#v, want UTF-8 string", got)
	}
}
