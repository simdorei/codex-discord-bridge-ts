// Independent test-only wrapper: declaration copied from frozen queue.rs; no runtime implementation.
use serde::{Deserialize,Serialize};
use std::io::{self,BufRead};
#[derive(Clone,Debug,Deserialize,Serialize)]
enum QueueJobState{Pending,Starting,Running,Quarantined}
#[derive(Clone,Debug,Deserialize,Serialize)]
struct StoredQueueJob{
 job_id:String,target_thread_id:String,channel_id:i64,owner_user_id:Option<i64>,discord_message_id:Option<i64>,app_server_generation:i64,execution_generation:Option<i64>,turn_observation_generation:Option<i64>,goal_waiting:bool,prompt:String,queued:bool,ack_sent:bool,state:QueueJobState,attempt_count:i64,turn_id:Option<String>,baseline_turn_ids:Vec<String>,last_error:String,created_at:f64,updated_at:f64,
}
#[derive(Deserialize)]struct Fixture{job:StoredQueueJob,created_bits:String,updated_bits:String}
fn main(){for line in io::stdin().lock().lines(){let input=line.expect("fixture");let mut fixture:Fixture=serde_json::from_str(&input).expect("owned fixture");fixture.job.created_at=f64::from_bits(u64::from_str_radix(&fixture.created_bits,16).expect("created bits"));fixture.job.updated_at=f64::from_bits(u64::from_str_radix(&fixture.updated_bits,16).expect("updated bits"));let serialized=serde_json::to_string(&fixture.job).expect("finite fixture");println!("{}",serde_json::json!({"input":input,"createdBits":fixture.created_bits,"updatedBits":fixture.updated_bits,"serialized":serialized}));}}