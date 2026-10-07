pub mod ingress {
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum IngressKind {
        Message,
        Interaction,
        Action,
    }

    impl IngressKind {
        #[allow(dead_code)]
        pub(crate) const fn as_str(self) -> &'static str {
            match self {
                Self::Message => "message",
                Self::Interaction => "interaction",
                Self::Action => "action",
            }
        }    }
}

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    pub ingress_id: String,
    pub job_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub state_db: String,
    pub channel_id: i64,
    pub origin_channel_id: i64,
    pub event_id: Option<i64>,
    pub kind: crate::ingress::IngressKind,
    pub creation_generation: i64,
    pub prompt_sha256: String,
    pub acknowledgement: String,
}

#[derive(Serialize)]
struct MetadataInfo {
    oracle: &'static str,
    serde: &'static str,
    serde_json: &'static str,
    case_count: usize,
}

#[derive(Serialize)]
struct MetadataLine {
    #[serde(rename = "type")]
    msg_type: &'static str,
    metadata: MetadataInfo,
}

#[derive(Serialize)]
struct CaseOutput<'a> {
    name: &'a str,
    raw: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<Identity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Case {
    name: String,
    raw: String,
}

const BASELINE: &str = r#"{"ingress_id":"ing_1","job_id":"job_1","thread_id":"th_1","cwd":"/app","state_db":"state.db","channel_id":100,"origin_channel_id":200,"event_id":300,"kind":"message","creation_generation":1,"prompt_sha256":"abc","acknowledgement":"ack_1"}"#;

fn main() {
    let mut cases: Vec<Case> = Vec::new();

    // 1. Baseline
    cases.push(Case {
        name: "baseline".to_string(),
        raw: BASELINE.to_string(),
    });

    // 2. Object missing event_id vs required missing
    let missing_cases: &[(&str, &str, &str)] = &[
        ("missing_event_id", ",\"event_id\":300", ""),
        ("missing_ingress_id", "\"ingress_id\":\"ing_1\",", ""),
        ("missing_job_id", "\"job_id\":\"job_1\",", ""),
        ("missing_thread_id", "\"thread_id\":\"th_1\",", ""),
        ("missing_cwd", "\"cwd\":\"/app\",", ""),
        ("missing_state_db", "\"state_db\":\"state.db\",", ""),
        ("missing_channel_id", "\"channel_id\":100,", ""),
        ("missing_origin_channel_id", "\"origin_channel_id\":200,", ""),
        ("missing_kind", "\"kind\":\"message\",", ""),
        ("missing_creation_generation", "\"creation_generation\":1,", ""),
        ("missing_prompt_sha256", "\"prompt_sha256\":\"abc\",", ""),
        ("missing_acknowledgement", ",\"acknowledgement\":\"ack_1\"", ""),
    ];
    for &(name, target, repl) in missing_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 3. Duplicate known + escaped names and duplicate null event
    let duplicate_cases: &[(&str, &str, &str)] = &[
        ("duplicate_known_job_id", "\"job_id\":\"job_1\"", "\"job_id\":\"job_1\",\"job_id\":\"job_2\""),
        ("escaped_name_job_id", "\"job_id\":\"job_1\"", r#""\u006aob_id":"job_1""#),
        ("duplicate_escaped_job_id", "\"job_id\":\"job_1\"", r#""job_id":"job_1","\u006aob_id":"job_2""#),
        ("duplicate_null_event_id", "\"event_id\":300", "\"event_id\":null,\"event_id\":null"),
        ("duplicate_event_id_some_then_null", "\"event_id\":300", "\"event_id\":300,\"event_id\":null"),
        ("duplicate_event_id_null_then_some", "\"event_id\":300", "\"event_id\":null,\"event_id\":400"),
    ];
    for &(name, target, repl) in duplicate_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 4. Unknown key duplicates
    cases.push(Case {
        name: "duplicate_unknown_key".to_string(),
        raw: BASELINE.replace(
            "\"acknowledgement\":\"ack_1\"",
            "\"acknowledgement\":\"ack_1\",\"extra\":\"val1\",\"extra\":\"val2\"",
        ),
    });

    // 5. Array exact 12 declaration fields + null event slot / truncations / extra field
    let array_cases: &[(&str, &str)] = &[
        ("array_exact_12", r#"["ing_1","job_1","th_1","/app","state.db",100,200,300,"message",1,"abc","ack_1"]"#),
        ("array_exact_12_null_event", r#"["ing_1","job_1","th_1","/app","state.db",100,200,null,"message",1,"abc","ack_1"]"#),
        ("array_truncated_2", r#"["ing_1","job_1"]"#),
        ("array_truncated_11", r#"["ing_1","job_1","th_1","/app","state.db",100,200,300,"message",1,"abc"]"#),
        ("array_extra_field_13", r#"["ing_1","job_1","th_1","/app","state.db",100,200,300,"message",1,"abc","ack_1","extra"]"#),
    ];
    for &(name, raw) in array_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: raw.to_string(),
        });
    }

    // 6. i64 variations on channel_id: 1.0, 1e0, -0, max, min, overflow, u64 max, 2^53+1
    let i64_cases: &[(&str, &str)] = &[
        ("i64_channel_id_float_1_0", "\"channel_id\":1.0"),
        ("i64_channel_id_exp_1e0", "\"channel_id\":1e0"),
        ("i64_channel_id_neg_zero", "\"channel_id\":-0"),
        ("i64_channel_id_max", "\"channel_id\":9223372036854775807"),
        ("i64_channel_id_min", "\"channel_id\":-9223372036854775808"),
        ("i64_channel_id_overflow", "\"channel_id\":9223372036854775808"),
        ("i64_channel_id_u64_max", "\"channel_id\":18446744073709551615"),
        ("i64_channel_id_2_pow_53_plus_1", "\"channel_id\":9007199254740993"),
    ];
    for &(name, repl) in i64_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace("\"channel_id\":100", repl),
        });
    }

    // 7. Enum string message/interaction/action vs invalid component and {"message":null}, non-null payload / multiple keys
    let enum_cases: &[(&str, &str)] = &[
        ("enum_message", "\"kind\":\"message\""),
        ("enum_interaction", "\"kind\":\"interaction\""),
        ("enum_action", "\"kind\":\"action\""),
        ("enum_invalid_component", "\"kind\":\"component\""),
        ("enum_object_message_null", "\"kind\":{\"message\":null}"),
        ("enum_object_message_non_null", "\"kind\":{\"message\":\"payload\"}"),
        ("enum_object_multiple_keys", "\"kind\":{\"message\":null,\"interaction\":null}"),
    ];
    for &(name, repl) in enum_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace("\"kind\":\"message\"", repl),
        });
    }

    // 8. unknown 1e999 vs known numeric / string
    let e999_cases: &[(&str, &str, &str)] = &[
        ("unknown_1e999", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":\"ack_1\",\"extra\":1e999"),
        ("known_numeric_channel_id_1e999", "\"channel_id\":100", "\"channel_id\":1e999"),
        ("known_string_ingress_id_1e999", "\"ingress_id\":\"ing_1\"", "\"ingress_id\":1e999"),
    ];
    for &(name, target, repl) in e999_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 9. unknown lone surrogates vs known String
    let surrogate_cases: &[(&str, &str, &str)] = &[
        ("unknown_lone_surrogate", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","extra":"\uD800""#),
        ("known_string_lone_surrogate", "\"ingress_id\":\"ing_1\"", r#""ingress_id":"\uD800""#),
    ];
    for &(name, target, repl) in surrogate_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 10. top-level Identity key lone surrogate vs key nested inside ignored unknown object
    let key_surrogate_cases: &[(&str, &str, &str)] = &[
        ("toplevel_key_lone_surrogate", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","\uD800":"val""#),
        ("nested_unknown_key_lone_surrogate", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","extra":{"\uD800":"val"}"#),
    ];
    for &(name, target, repl) in key_surrogate_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 11. known string valid surrogate pair
    cases.push(Case {
        name: "known_string_valid_surrogate_pair".to_string(),
        raw: BASELINE.replace("\"ingress_id\":\"ing_1\"", r#""ingress_id":"\uD83D\uDE00""#),
    });

    // 12. unknown container depths 127, 128, 129, 150, 256 plus known-string container counterparts
    let depths = [127, 128, 129, 150, 256];
    for &d in &depths {
        let open = "[".repeat(d);
        let close = "]".repeat(d);
        let nested = format!("{}1{}", open, close);

        cases.push(Case {
            name: format!("unknown_container_depth_{}", d),
            raw: BASELINE.replace(
                "\"acknowledgement\":\"ack_1\"",
                &format!("\"acknowledgement\":\"ack_1\",\"extra\":{}", nested),
            ),
        });

        cases.push(Case {
            name: format!("known_string_container_depth_{}", d),
            raw: BASELINE.replace(
                "\"ingress_id\":\"ing_1\"",
                &format!("\"ingress_id\":{}", nested),
            ),
        });
    }

    // Output NDJSON: metadata line first
    let meta = MetadataLine {
        msg_type: "metadata",
        metadata: MetadataInfo {
            oracle: "new-reply-identity-1.0.151",
            serde: "1.0.228",
            serde_json: "1.0.151",
            case_count: cases.len(),
        },
    };
    println!("{}", serde_json::to_string(&meta).unwrap());

    // Output NDJSON: for every case
    for case in &cases {
        match serde_json::from_str::<Identity>(&case.raw) {
            Ok(identity) => {
                let output = CaseOutput {
                    name: &case.name,
                    raw: &case.raw,
                    ok: true,
                    identity: Some(identity),
                    error: None,
                };
                println!("{}", serde_json::to_string(&output).unwrap());
            }
            Err(err) => {
                let output = CaseOutput {
                    name: &case.name,
                    raw: &case.raw,
                    ok: false,
                    identity: None,
                    error: Some(err.to_string()),
                };
                println!("{}", serde_json::to_string(&output).unwrap());
            }
        }    }
}
