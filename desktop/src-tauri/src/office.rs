//! The office address: what the setup page accepts, and where the office window may go.

use tauri::Url;

/// Reads an address typed by a person ("office.example.com", "https://office.example.com/o/team").
/// The office needs a secure page for the camera and microphone, so it must be HTTPS, or plain HTTP
/// on this computer (a local server).
pub fn parse(address: &str) -> Result<Url, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("Enter the address of your office.".into());
    }
    let with_scheme = if address.contains("://") { address.to_string() } else { format!("https://{address}") };
    let mut url = Url::parse(&with_scheme).map_err(|_| "This is not a web address.".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => return Err("The office must use HTTPS (http:// only works for a server on this computer).".into()),
        _ => return Err("This is not a web address.".into()),
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("This is not a web address.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the name and password out of the address.".into());
    }
    url.set_fragment(None);
    Ok(url)
}

/// Pages the office window may show: the web (the office, a sign-in provider and back) and the bundled
/// setup page. Never files, scripts in the address bar or other schemes.
pub fn navigable(url: &Url) -> bool {
    match url.scheme() {
        "https" | "http" => true,
        "tauri" => url.host_str() == Some("localhost"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_offices_people_type() {
        for (typed, want) in [
            ("office.example.com", "https://office.example.com/"),
            ("  https://office.example.com/o/team  ", "https://office.example.com/o/team"),
            ("https://office.example.com:8443/#x", "https://office.example.com:8443/"),
            ("http://localhost:8080", "http://localhost:8080/"),
            ("http://127.0.0.1:5173/", "http://127.0.0.1:5173/"),
            ("http://[::1]:8080", "http://[::1]:8080/"),
        ] {
            assert_eq!(parse(typed).map(|u| u.to_string()), Ok(want.to_string()), "{typed}");
        }
    }

    #[test]
    fn refuses_what_cannot_be_an_office() {
        for typed in [
            "",
            "   ",
            "http://office.example.com",
            "http://192.168.1.10:8080",
            "ftp://office.example.com",
            "file:///C:/Windows",
            "javascript:alert(1)",
            "https://user:secret@office.example.com",
            "https://",
        ] {
            assert!(parse(typed).is_err(), "{typed:?} must be refused");
        }
    }

    #[test]
    fn the_window_stays_on_web_pages() {
        for (url, ok) in [
            ("https://office.example.com/", true),
            ("https://accounts.google.com/o/oauth2/auth", true),
            ("http://tauri.localhost/index.html", true),
            ("tauri://localhost/index.html", true),
            ("file:///C:/Windows/win.ini", false),
            ("javascript:alert(1)", false),
            ("tauri://evil/index.html", false),
            ("ms-settings:privacy", false),
        ] {
            assert_eq!(navigable(&Url::parse(url).unwrap()), ok, "{url}");
        }
    }
}
