
use std::path::{Path, PathBuf, Component};
fn normalized(path: &str) -> String {
 let value=path.trim();
 let stripped=if let Some(rest)=value.strip_prefix(r"\\?\UNC\") {format!(r"\\{}",rest)}
 else if let Some(rest)=value.strip_prefix(r"\\?\") {rest.to_owned()} else {value.to_owned()};
 let mut normalized=PathBuf::new();
 for component in Path::new(&stripped).components() { match component {
  Component::CurDir=>{},Component::ParentDir=>{normalized.pop();},other=>normalized.push(other.as_os_str()),
 }}
 normalized.to_string_lossy().to_lowercase()
}
fn hex(s:&str)->String {s.as_bytes().iter().map(|b|format!("{:02x}",b)).collect()}
fn main() {
 let paths:Vec<_>=std::env::args().skip(1).collect();
 for (i,p) in paths.iter().enumerate() {
  let leaf=Path::new(p).file_name().and_then(|s|s.to_str()).unwrap_or("");
  let equal=paths.iter().enumerate().filter(|(_,q)|Path::new(p)==Path::new(q)).map(|(j,_)|j.to_string()).collect::<Vec<_>>().join(",");
  println!("{}\t{}\t{}\t{}",i,hex(&normalized(p)),hex(leaf),equal);
 }
}
