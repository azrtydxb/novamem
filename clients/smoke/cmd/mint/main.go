// Command mint signs in a novamem user and prints a fresh nm_ bearer token,
// for the sdk-smoke CI job:
//
//	mint -wait 90s -email admin@example.com -password … [-label sdk-smoke] [-url http://127.0.0.1:7778]
//
// With -wait it first polls GET /ready until the server answers 200, so the
// job's minimal images need no curl. Any non-2xx exits 1 with the status and
// body; only the token is printed on stdout.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	url := flag.String("url", "http://127.0.0.1:7778", "server root")
	email := flag.String("email", "", "user email")
	password := flag.String("password", "", "user password")
	label := flag.String("label", "sdk-smoke", "token label")
	wait := flag.Duration("wait", 0, "poll GET /ready this long before signing in")
	flag.Parse()
	if err := run(*url, *email, *password, *label, *wait); err != nil {
		fmt.Fprintln(os.Stderr, "mint:", err)
		os.Exit(1)
	}
}

func run(url, email, password, label string, wait time.Duration) error {
	client := &http.Client{Timeout: 10 * time.Second}
	if wait > 0 {
		if err := waitReady(client, url, wait); err != nil {
			return err
		}
	}
	resp, err := post(client, url, "/api/auth/sign-in/email", "", map[string]string{"email": email, "password": password})
	if err != nil {
		return err
	}
	var cookies []string
	for _, c := range resp.Cookies() {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	if len(cookies) == 0 {
		return fmt.Errorf("sign-in set no cookie")
	}
	resp, err = post(client, url, "/v1/me/tokens", strings.Join(cookies, "; "), map[string]string{"label": label})
	if err != nil {
		return err
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		return fmt.Errorf("mint: no token in the response (%v)", err)
	}
	fmt.Println(out.Token)
	return nil
}

func waitReady(client *http.Client, url string, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for {
		resp, err := client.Get(url + "/ready")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s/ready did not answer 200 within %s (last error: %v)", url, wait, err)
		}
		time.Sleep(time.Second)
	}
}

// post sends a JSON body with the Origin header the auth routes require,
// and returns the response only when it is 2xx.
func post(client *http.Client, url, path, cookie string, body any) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, url+path, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", url)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("POST %s: %w", path, err)
	}
	if resp.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		return nil, fmt.Errorf("POST %s: %d %s", path, resp.StatusCode, bytes.TrimSpace(detail))
	}
	return resp, nil
}
