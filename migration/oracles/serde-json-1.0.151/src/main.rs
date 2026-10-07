// Independent validation oracle only; not migrated runtime implementation.
use std::io::{self, BufRead};
use sha2::{Digest, Sha256};
fn main() {
 for line in io::stdin().lock().lines() {
  let line=line.expect("fixture stdin");
  let value:serde_json::Value=if let Some(raw)=line.strip_prefix("bits:") { let bits=u64::from_str_radix(raw,16).expect("fixture bits"); let n=f64::from_bits(bits); serde_json::Value::Number(serde_json::Number::from_f64(n).expect("finite fixture")) } else if let Some(raw)=line.strip_prefix("f64:") {
   let n=raw.parse::<f64>().expect("fixture f64");
   serde_json::Value::Number(serde_json::Number::from_f64(n).expect("finite fixture"))
  } else {serde_json::from_str(&line).expect("fixture JSON")};
  let serialized=serde_json::to_string(&value).expect("serialize fixture");
  let digest=Sha256::digest(serialized.as_bytes()).iter().map(|b|format!("{b:02x}")).collect::<String>();
  println!("{}",serde_json::json!({"input":line,"serialized":serialized,"sha256":digest}));
 }
}