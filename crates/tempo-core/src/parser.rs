use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Result of parsing `@project` and `#tag` quick-entry syntax from a timer input string.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedQuickEntry {
    pub description: String,
    pub project_hint: Option<String>,
    pub tag_names: Vec<String>,
}

/// Parses quick-entry shorthand tokens from a free-text timer description.
///
/// Rules:
/// - `@project` or `@"Multi Word Project"` extracts a project hint (last one wins if repeated).
/// - `#tag` or `#"Multi Word Tag"` extracts tag names (deduplicated case-insensitively, order preserved).
/// - Prefixes `@` and `#` are only recognized at the start of the string or immediately after whitespace,
///   so emails (`user@example.com`), URL fragments (`https://a.com#top`), and tokens like `C#` remain untouched.
pub fn parse_quick_entry(input: &str) -> ParsedQuickEntry {
    let mut description_parts: Vec<String> = Vec::new();
    let mut project_hint: Option<String> = None;
    let mut tag_names: Vec<String> = Vec::new();
    let mut seen_tags: HashSet<String> = HashSet::new();

    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Skip leading whitespace between tokens.
        while i < len && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= len {
            break;
        }

        let start = i;
        let ch = chars[i];

        if ch == '@' || ch == '#' {
            let is_project = ch == '@';
            if i + 1 < len && chars[i + 1] == '"' {
                // Quoted token: @"My Project" or #"Deep Work"
                let mut end = i + 2;
                while end < len && chars[end] != '"' {
                    end += 1;
                }
                if end < len && chars[end] == '"' {
                    let raw: String = chars[i + 2..end].iter().collect();
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        if is_project {
                            project_hint = Some(trimmed.to_string());
                        } else {
                            let key = trimmed.to_lowercase();
                            if seen_tags.insert(key) {
                                tag_names.push(trimmed.to_string());
                            }
                        }
                        i = end + 1;
                        continue;
                    }
                }
            } else {
                // Unquoted token until next whitespace.
                let mut end = i + 1;
                while end < len && !chars[end].is_whitespace() {
                    end += 1;
                }
                let raw: String = chars[i + 1..end].iter().collect();
                let cleaned = raw.trim_end_matches(|c: char| {
                    matches!(c, ',' | '.' | ';' | ':' | '!' | '?' | ')' | ']')
                });
                if !cleaned.is_empty() && !cleaned.starts_with('@') && !cleaned.starts_with('#') {
                    if is_project {
                        project_hint = Some(cleaned.to_string());
                    } else {
                        let key = cleaned.to_lowercase();
                        if seen_tags.insert(key) {
                            tag_names.push(cleaned.to_string());
                        }
                    }
                    // Preserve any trailing punctuation that was stripped from the token?
                    // Usually punctuation after `#tag,` is just a list separator, so discard it.
                    i = end;
                    continue;
                }
            }
        }

        // Plain description word.
        let mut end = start;
        while end < len && !chars[end].is_whitespace() {
            end += 1;
        }
        let word: String = chars[start..end].iter().collect();
        description_parts.push(word);
        i = end;
    }

    ParsedQuickEntry {
        description: description_parts.join(" "),
        project_hint,
        tag_names,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_and_multiple_tags_with_unicode() {
        let parsed = parse_quick_entry("API 문서 정리 @Work #deep-work #docs #문서");
        assert_eq!(parsed.description, "API 문서 정리");
        assert_eq!(parsed.project_hint.as_deref(), Some("Work"));
        assert_eq!(parsed.tag_names, vec!["deep-work", "docs", "문서"]);
    }

    #[test]
    fn supports_quoted_project_and_tag_names() {
        let parsed = parse_quick_entry(r#"Design review @"Client Alpha" #"Q4 Planning" #ux"#);
        assert_eq!(parsed.description, "Design review");
        assert_eq!(parsed.project_hint.as_deref(), Some("Client Alpha"));
        assert_eq!(parsed.tag_names, vec!["Q4 Planning", "ux"]);
    }

    #[test]
    fn deduplicates_tags_case_insensitively_and_last_project_wins() {
        let parsed = parse_quick_entry("@Inbox Refactor @Work #Rust #rust #Focus");
        assert_eq!(parsed.description, "Refactor");
        assert_eq!(parsed.project_hint.as_deref(), Some("Work"));
        assert_eq!(parsed.tag_names, vec!["Rust", "Focus"]);
    }

    #[test]
    fn ignores_mid_word_at_and_hash_such_as_emails_urls_and_csharp() {
        let parsed = parse_quick_entry(
            "Email alice@example.com about C# & https://docs.rs/tempo#section @업무 #dev",
        );
        assert_eq!(
            parsed.description,
            "Email alice@example.com about C# & https://docs.rs/tempo#section"
        );
        assert_eq!(parsed.project_hint.as_deref(), Some("업무"));
        assert_eq!(parsed.tag_names, vec!["dev"]);
    }

    #[test]
    fn leaves_lone_prefixes_and_empty_inputs_safe() {
        assert_eq!(parse_quick_entry("   "), ParsedQuickEntry::default());

        let lone = parse_quick_entry("Meet @ # soon");
        assert_eq!(lone.description, "Meet @ # soon");
        assert_eq!(lone.project_hint, None);
        assert!(lone.tag_names.is_empty());
    }

    #[test]
    fn trims_trailing_punctuation_from_tokens() {
        let parsed = parse_quick_entry("Fix login bug @Work, #bugfix, #urgent.");
        assert_eq!(parsed.description, "Fix login bug");
        assert_eq!(parsed.project_hint.as_deref(), Some("Work"));
        assert_eq!(parsed.tag_names, vec!["bugfix", "urgent"]);
    }
}
