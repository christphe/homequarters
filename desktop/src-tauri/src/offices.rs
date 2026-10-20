//! The offices this computer knows: the one open now, and the list the menus switch between.

use serde::{Deserialize, Serialize};
use tauri::Url;

/// More is a list nobody reads; adding one more drops the oldest that is not open.
const MAX: usize = 20;
/// The web client's page title in an office ("app.titleOffice" in web/src/i18n.ts).
const TITLE_PREFIX: &str = "Home Quarters - ";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Office {
    pub url: String,
    /// The office's name, read from the page title once it has been opened.
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Offices {
    #[serde(default)]
    pub current: Option<String>,
    #[serde(default)]
    pub list: Vec<Office>,
}

impl Offices {
    /// Makes `url` the office open now, adding it to the list if it is new.
    pub fn open(&mut self, url: &str) {
        if !self.list.iter().any(|o| o.url == url) {
            self.list.push(Office { url: url.to_string(), name: None });
            while self.list.len() > MAX {
                let Some(i) = self.list.iter().position(|o| Some(&o.url) != self.current.as_ref()) else { break };
                self.list.remove(i);
            }
        }
        self.current = Some(url.to_string());
    }

    /// Forgets an office. Forgetting the open one leaves no office to open at the next start.
    pub fn remove(&mut self, url: &str) {
        self.list.retain(|o| o.url != url);
        if self.current.as_deref() == Some(url) {
            self.current = None;
        }
    }

    /// Learns the name of the office a page belongs to from its title. True when something changed.
    pub fn learn_name(&mut self, page: &Url, title: &str) -> bool {
        let Some(name) = title.strip_prefix(TITLE_PREFIX).map(str::trim).filter(|n| !n.is_empty()) else { return false };
        let page = page.as_str();
        let Some(office) = self.list.iter_mut().filter(|o| page.starts_with(o.url.as_str())).max_by_key(|o| o.url.len()) else { return false };
        if office.name.as_deref() == Some(name) {
            return false;
        }
        office.name = Some(name.to_string());
        true
    }
}

/// What the menus show for an office: its name, else its address without the scheme.
pub fn label(office: &Office) -> String {
    match &office.name {
        Some(n) => n.clone(),
        None => office.url.split("://").nth(1).unwrap_or(&office.url).trim_end_matches('/').to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn opening_adds_once_and_keeps_the_order() {
        let mut o = Offices::default();
        o.open("https://a.example/");
        o.open("https://b.example/");
        o.open("https://a.example/");
        assert_eq!(o.list.iter().map(|x| x.url.as_str()).collect::<Vec<_>>(), ["https://a.example/", "https://b.example/"]);
        assert_eq!(o.current.as_deref(), Some("https://a.example/"));
    }

    #[test]
    fn the_list_is_bounded_and_never_drops_the_open_office() {
        let mut o = Offices::default();
        o.open("https://first.example/");
        for i in 0..MAX + 5 {
            o.open(&format!("https://o{i}.example/"));
            o.current = Some("https://first.example/".into()); // the first one stays open meanwhile
        }
        assert_eq!(o.list.len(), MAX);
        assert!(o.list.iter().any(|x| x.url == "https://first.example/"));
    }

    #[test]
    fn removing_the_open_office_leaves_none_open() {
        let mut o = Offices::default();
        o.open("https://a.example/");
        o.open("https://b.example/");
        o.remove("https://b.example/");
        assert_eq!(o.current, None);
        assert_eq!(o.list.len(), 1);
        o.remove("https://nope.example/");
        assert_eq!(o.list.len(), 1);
    }

    #[test]
    fn names_come_from_the_office_page_title() {
        let mut o = Offices::default();
        o.open("https://hq.example/");
        o.open("https://hq.example/o/team/");
        assert!(o.learn_name(&url("https://hq.example/o/team/room?x=1"), "Home Quarters - Team"));
        assert_eq!(o.list[1].name.as_deref(), Some("Team"), "the longest matching office wins");
        assert_eq!(o.list[0].name, None);
        assert!(!o.learn_name(&url("https://hq.example/o/team/"), "Home Quarters - Team"), "unchanged");
        assert!(!o.learn_name(&url("https://hq.example/"), "Home Quarters"), "the join screen has no office name");
        assert!(!o.learn_name(&url("https://other.example/"), "Home Quarters - Other"), "not a saved office");
        assert_eq!(label(&o.list[0]), "hq.example");
        assert_eq!(label(&o.list[1]), "Team");
    }
}
