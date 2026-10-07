fn main() {
  let mut checked=0u64;
  for cp in 0..=0x10ffffu32 {
    let Some(c)=char::from_u32(cp) else {continue};
    let single=format!("{:?}",c.to_string());
    let body=&single[1..single.len()-1];
    for (prefix,suffix) in [("a",""),("","b"),("a","b")] {
      let text=format!("{prefix}{c}{suffix}");
      let expected=format!("\"{prefix}{body}{suffix}\"");
      assert_eq!(format!("{text:?}"),expected,"context differs at U+{cp:x}");
      checked+=1;
    }
  }
  for text in ["a\u{301}", "\u{301}a", "👩\u{200d}👧", "\u{feff}\0\n\"\\", "한글😀\u{85}"] {
    let mut expected=String::from("\"");
    for c in text.chars() {
      let single=format!("{:?}",c.to_string());
      expected.push_str(&single[1..single.len()-1]);
    }
    expected.push('"');
    assert_eq!(format!("{text:?}"),expected,"composed sample differs");
  }
  println!("composition_checks={checked}; sample_checks=5; mismatches=0");
}
