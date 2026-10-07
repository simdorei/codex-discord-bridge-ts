use serde_json::json;
fn main() {
    let mut ranges: Vec<(u32,u32)> = Vec::new();
    let mut count=0u32;
    for cp in 0..=0x10ffffu32 {
        let Some(c)=char::from_u32(cp) else { continue };
        let text=c.to_string();
        let debug=format!("{text:?}");
        let raw=format!("\"{text}\"");
        if debug==raw { continue; }
        let expected=match c {
            '\0' => "\"\\0\"".to_owned(),
            '\t' => "\"\\t\"".to_owned(),
            '\r' => "\"\\r\"".to_owned(),
            '\n' => "\"\\n\"".to_owned(),
            '\\' => "\"\\\\\"".to_owned(),
            '"' => "\"\\\"\"".to_owned(),
            _ => format!("\"\\u{{{cp:x}}}\""),
        };
        assert_eq!(debug,expected,"unexpected Rust Debug form for U+{cp:x}");
        if matches!(c,'\0'|'\t'|'\r'|'\n'|'\\'|'"') { continue; }
        count+=1;
        if let Some(last)=ranges.last_mut() {
            if last.1+1==cp { last.1=cp; continue; }
        }
        ranges.push((cp,cp));
    }
    let samples=["","a\0b","a\nb","한글😀","\u{85}","\u{feff}","\"\\"];
    let cases:Vec<_>=samples.iter().map(|s|json!({"input":s,"expected":format!("{s:?}")})).collect();
    println!("{}",json!({"unicode_escape_ranges":ranges,"escaped_scalar_count":count,"cases":cases}));
}