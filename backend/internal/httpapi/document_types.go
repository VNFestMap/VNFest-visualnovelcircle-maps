package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"io"
	"path/filepath"
	"strings"
)

func safeDocumentExtension(filename string, data []byte) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
	switch ext {
	case "pdf":
		if bytes.HasPrefix(data, []byte("%PDF-")) {
			return ext
		}
	case "docx", "xlsx":
		z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil || len(z.File) > 2000 {
			return ""
		}
		types, main := false, false
		seen := make(map[string]bool)
		var size uint64
		expected := "word/document.xml"
		if ext == "xlsx" {
			expected = "xl/workbook.xml"
		}
		contentType := "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
		rootName, rootSpace := "document", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
		if ext == "xlsx" {
			contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
			rootName, rootSpace = "workbook", "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
		}
		for _, f := range z.File {
			key := strings.ToLower(f.Name)
			if seen[key] || f.Flags&1 != 0 || f.UncompressedSize64 > 100<<20 || size > (100<<20)-f.UncompressedSize64 {
				return ""
			}
			seen[key] = true
			size += f.UncompressedSize64
			if size > 100<<20 || strings.Contains(f.Name, "..") || strings.HasPrefix(f.Name, "/") {
				return ""
			}
			if f.Name == "[Content_Types].xml" {
				data := boundedOfficeXML(f, 2<<20)
				var declared struct {
					XMLName   xml.Name
					Overrides []struct {
						Part string `xml:"PartName,attr"`
						Type string `xml:"ContentType,attr"`
					} `xml:"Override"`
				}
				if xml.Unmarshal(data, &declared) != nil || declared.XMLName.Local != "Types" || declared.XMLName.Space != "http://schemas.openxmlformats.org/package/2006/content-types" {
					return ""
				}
				for _, part := range declared.Overrides {
					if part.Part == "/"+expected && part.Type == contentType {
						types = true
					}
				}
			}
			if f.Name == expected {
				data := boundedOfficeXML(f, 8<<20)
				var document struct{ XMLName xml.Name }
				if xml.Unmarshal(data, &document) != nil || document.XMLName.Local != rootName {
					return ""
				}
				strictSpace := "http://purl.oclc.org/ooxml/wordprocessingml/main"
				if ext == "xlsx" {
					strictSpace = "http://purl.oclc.org/ooxml/spreadsheetml/main"
				}
				main = document.XMLName.Space == rootSpace || document.XMLName.Space == strictSpace
			}
			if strings.HasSuffix(strings.ToLower(f.Name), "vbaproject.bin") {
				return ""
			}
		}
		if types && main {
			return ext
		}
	case "doc", "xls":
		magic := []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}
		if len(data) < 512 || !bytes.Equal(data[:8], magic) || binary.LittleEndian.Uint16(data[28:30]) != 0xfffe {
			return ""
		}
		shift := binary.LittleEndian.Uint16(data[30:32])
		if shift != 9 && shift != 12 {
			return ""
		}
		sector := int64(1) << shift
		dir := int64(binary.LittleEndian.Uint32(data[48:52]))
		offset := (dir + 1) * sector
		if offset < sector || offset+sector > int64(len(data)) {
			return ""
		}
		for start := offset; start < offset+sector; start += 128 {
			entry := data[start : start+128]
			n := int(binary.LittleEndian.Uint16(entry[64:66]))
			if n < 2 || n > 64 || entry[66] != 2 {
				continue
			}
			name := ""
			for i := 0; i < n-2; i += 2 {
				c := binary.LittleEndian.Uint16(entry[i : i+2])
				if c > 127 {
					name = ""
					break
				}
				name += string(rune(c))
			}
			if ext == "doc" && name == "WordDocument" || ext == "xls" && (name == "Workbook" || name == "Book") {
				return ext
			}
		}
	}
	return ""
}

func boundedOfficeXML(file *zip.File, limit int64) []byte {
	if file.UncompressedSize64 > uint64(limit) {
		return nil
	}
	reader, err := file.Open()
	if err != nil {
		return nil
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil
	}
	return data
}
