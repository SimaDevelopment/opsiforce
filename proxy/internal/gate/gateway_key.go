package gate

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

var gatewayKeyPattern = regexp.MustCompile(`(?:^|[^A-Za-z0-9_-])(gw-[A-Za-z0-9_-]+)`)

var basicCredentialsPattern = regexp.MustCompile(`(?i)^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$`)

var basicEncodings = []*base64.Encoding{
	base64.StdEncoding,
	base64.RawStdEncoding,
	base64.URLEncoding,
	base64.RawURLEncoding,
}

type presentedKey struct {
	key        string
	credential string
	headers    []string
}

func gatewayKeyIn(value string) string {
	searched := value
	if basic := basicCredentialsPattern.FindStringSubmatch(value); basic != nil {
		searched = decodedBasic(basic[1])
	}
	if match := gatewayKeyPattern.FindStringSubmatch(searched); match != nil {
		return match[1]
	}
	return ""
}

func decodedBasic(encoded string) string {
	for _, encoding := range basicEncodings {
		if decoded, err := encoding.DecodeString(encoded); err == nil {
			return string(decoded)
		}
	}
	return ""
}

func findGatewayKey(header http.Header) (presentedKey, bool) {
	var found presentedKey
	for _, name := range headerNamesAuthorizationFirst(header) {
		for _, value := range header[name] {
			key := gatewayKeyIn(value)
			if key == "" {
				continue
			}
			if found.key == "" {
				found.key, found.credential = key, value
			}
			found.headers = append(found.headers, name)
			break
		}
	}
	return found, found.key != ""
}

func headerNamesAuthorizationFirst(header http.Header) []string {
	names := make([]string, 0, len(header))
	for name := range header {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		iAuthorization := strings.EqualFold(names[i], "Authorization")
		jAuthorization := strings.EqualFold(names[j], "Authorization")
		if iAuthorization != jAuthorization {
			return iAuthorization
		}
		return names[i] < names[j]
	})
	return names
}
