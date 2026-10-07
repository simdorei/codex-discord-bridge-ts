use rusqlite::{Connection, params};
use serde_json::json;
fn main() -> Result<(), Box<dyn std::error::Error>> {
  let cases: Vec<Vec<u8>> = vec![
    vec![0x00,0xd8,0x41,0x00],
    vec![0x00,0xdc,0x41,0x00],
    vec![0x00,0xd8,0x00,0xd8],
    vec![0x00,0xdc,0x00,0xd8],
    vec![0x00,0xd8], vec![0x00,0xdc],
    vec![0x41,0x00,0xff], vec![0xff],
    vec![0x00,0x00], vec![0xff,0xfe,0x41,0x00],
    vec![0x3d,0xd8,0x00,0xde],
  ];
  for encoding in ["UTF-16le", "UTF-16be"] {
    let db = Connection::open_in_memory()?;
    db.execute_batch(&format!("PRAGMA encoding='{encoding}'; CREATE TABLE t(v TEXT);"))?;
    let mut stmt = db.prepare("PRAGMA compile_options")?;
    let options: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_,_>>()?;
    println!("{}",json!({"meta":true,"encoding":encoding,"sqlite":rusqlite::version(),"options":options}));
    for (index, little) in cases.iter().enumerate() {
      let mut bytes=little.clone();
      if encoding == "UTF-16be" { for pair in bytes.chunks_exact_mut(2) { pair.swap(0,1); } }
      db.execute("DELETE FROM t", [])?;
      db.execute("INSERT INTO t VALUES(CAST(? AS TEXT))",params![bytes])?;
      let raw: Vec<u8> = db.query_row("SELECT CAST(v AS BLOB) FROM t",[],|r|r.get(0))?;
      let result: Result<String, _> = db.query_row("SELECT v FROM t",[],|r|r.get(0));
      match result {
        Ok(value) => println!("{}",json!({"encoding":encoding,"index":index,"bytes":raw,"ok":true,"value":value})),
        Err(error) => println!("{}",json!({"encoding":encoding,"index":index,"bytes":raw,"ok":false,"error":error.to_string()})),
      }
    }
  }
  Ok(())
}