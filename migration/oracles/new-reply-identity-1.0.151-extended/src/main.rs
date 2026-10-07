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
        }
    }
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

    // 13. Additional enum object cases: interaction/action object:null, duplicate key, empty, invalid payloads
    let additional_enum_cases: &[(&str, &str)] = &[
        ("enum_object_interaction_null", "\"kind\":{\"interaction\":null}"),
        ("enum_object_action_null", "\"kind\":{\"action\":null}"),
        ("enum_object_duplicate_key_same_variant", "\"kind\":{\"message\":null,\"message\":null}"),
        ("enum_object_empty", "\"kind\":{}"),
        ("enum_object_payload_bool", "\"kind\":{\"message\":true}"),
        ("enum_object_payload_number", "\"kind\":{\"message\":123}"),
        ("enum_object_payload_string", "\"kind\":{\"message\":\"invalid_payload\"}"),
        ("enum_object_payload_array", "\"kind\":{\"message\":[]}"),
        ("enum_object_payload_object", "\"kind\":{\"message\":{}}"),
    ];
    for &(name, repl) in additional_enum_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace("\"kind\":\"message\"", repl),
        });
    }

    // 14. Empty strings for EACH required String field
    let empty_string_cases: &[(&str, &str, &str)] = &[
        ("empty_string_ingress_id", "\"ingress_id\":\"ing_1\"", "\"ingress_id\":\"\""),
        ("empty_string_job_id", "\"job_id\":\"job_1\"", "\"job_id\":\"\""),
        ("empty_string_thread_id", "\"thread_id\":\"th_1\"", "\"thread_id\":\"\""),
        ("empty_string_cwd", "\"cwd\":\"/app\"", "\"cwd\":\"\""),
        ("empty_string_state_db", "\"state_db\":\"state.db\"", "\"state_db\":\"\""),
        ("empty_string_prompt_sha256", "\"prompt_sha256\":\"abc\"", "\"prompt_sha256\":\"\""),
        ("empty_string_acknowledgement", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":\"\""),
    ];
    for &(name, target, repl) in empty_string_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 15. null, bool, and wrong numeric types for known fields
    let known_fields: &[(&str, &str, &str, &str)] = &[
        ("ingress_id", "\"ingress_id\":\"ing_1\"", "\"ingress_id\":123", "\"ingress_id\":true"),
        ("job_id", "\"job_id\":\"job_1\"", "\"job_id\":123", "\"job_id\":true"),
        ("thread_id", "\"thread_id\":\"th_1\"", "\"thread_id\":123", "\"thread_id\":true"),
        ("cwd", "\"cwd\":\"/app\"", "\"cwd\":123", "\"cwd\":true"),
        ("state_db", "\"state_db\":\"state.db\"", "\"state_db\":123", "\"state_db\":true"),
        ("channel_id", "\"channel_id\":100", "\"channel_id\":123.45", "\"channel_id\":true"),
        ("origin_channel_id", "\"origin_channel_id\":200", "\"origin_channel_id\":123.45", "\"origin_channel_id\":true"),
        ("event_id", "\"event_id\":300", "\"event_id\":123.45", "\"event_id\":true"),
        ("kind", "\"kind\":\"message\"", "\"kind\":123", "\"kind\":true"),
        ("creation_generation", "\"creation_generation\":1", "\"creation_generation\":123.45", "\"creation_generation\":true"),
        ("prompt_sha256", "\"prompt_sha256\":\"abc\"", "\"prompt_sha256\":123", "\"prompt_sha256\":true"),
        ("acknowledgement", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":123", "\"acknowledgement\":true"),
    ];
    for &(field, target, wrong_num, bool_repl) in known_fields {
        let null_repl = format!("\"{}\":null", field);
        cases.push(Case {
            name: format!("known_field_null_{}", field),
            raw: BASELINE.replace(target, &null_repl),
        });
        cases.push(Case {
            name: format!("known_field_bool_{}", field),
            raw: BASELINE.replace(target, bool_repl),
        });
        cases.push(Case {
            name: format!("known_field_wrong_numeric_{}", field),
            raw: BASELINE.replace(target, wrong_num),
        });
    }

    // 16. ALL i64 fields variations (origin_channel_id, event_id, creation_generation, and underflow for channel_id)
    cases.push(Case {
        name: "i64_channel_id_underflow".to_string(),
        raw: BASELINE.replace("\"channel_id\":100", "\"channel_id\":-9223372036854775809"),
    });

    let other_i64_fields: &[(&str, &str)] = &[
        ("origin_channel_id", "\"origin_channel_id\":200"),
        ("event_id", "\"event_id\":300"),
        ("creation_generation", "\"creation_generation\":1"),
    ];

    let i64_variants: &[(&str, &str)] = &[
        ("float_1_0", "1.0"),
        ("exp_1e0", "1e0"),
        ("neg_zero", "-0"),
        ("max", "9223372036854775807"),
        ("min", "-9223372036854775808"),
        ("overflow", "9223372036854775808"),
        ("underflow", "-9223372036854775809"),
        ("u64_max", "18446744073709551615"),
        ("2_pow_53_plus_1", "9007199254740993"),
    ];

    for &(field, target) in other_i64_fields {
        for &(var_suffix, val) in i64_variants {
            cases.push(Case {
                name: format!("i64_{}_{}", field, var_suffix),
                raw: BASELINE.replace(target, &format!("\"{}\":{}", field, val)),
            });
        }
    }

    // 17. Unknown malformed JSON: 1e+, invalidescape, trailing commas, bracket mismatch
    let malformed_cases: &[(&str, &str, &str)] = &[
        ("malformed_json_1e_plus", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":\"ack_1\",\"extra\":1e+"),
        ("malformed_json_invalid_escape", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","extra":"\z""#),
        ("malformed_json_invalid_escape_hex", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","extra":"\u000Z""#),
        ("malformed_json_trailing_comma_object", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":\"ack_1\","),
        ("malformed_json_trailing_comma_unknown_array", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":\"ack_1\",\"extra\":[1,2,]"),
        ("malformed_json_bracket_mismatch_close", "\"acknowledgement\":\"ack_1\"}", "\"acknowledgement\":\"ack_1\"]"),
        ("malformed_json_bracket_unclosed_object", "\"acknowledgement\":\"ack_1\"}", "\"acknowledgement\":\"ack_1\""),
        ("malformed_json_bracket_extra_brace", "\"acknowledgement\":\"ack_1\"}", "\"acknowledgement\":\"ack_1\"}}"),
        ("malformed_json_bracket_mismatched_container", "\"acknowledgement\":\"ack_1\"", "\"acknowledgement\":\"ack_1\",\"extra\":{\"nested\":[1,2}}"),
    ];
    for &(name, target, repl) in malformed_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 18. Additional direct and nested ignored lone-surrogate keys
    let additional_key_surrogate_cases: &[(&str, &str, &str)] = &[
        ("toplevel_key_lone_surrogate_low", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","\uDFFF":"val""#),
        ("nested_unknown_key_lone_surrogate_low", "\"acknowledgement\":\"ack_1\"", r#""acknowledgement":"ack_1","extra":{"\uDFFF":"val"}"#),
    ];
    for &(name, target, repl) in additional_key_surrogate_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace(target, repl),
        });
    }

    // 19. Ignored unknown object nesting depth 256 and known-string object nesting depth 256
    let mut open_obj = String::with_capacity(256 * 5);
    let mut close_obj = String::with_capacity(256);
    for _ in 0..256 {
        open_obj.push_str("{\"k\":");
        close_obj.push('}');
    }
    let nested_obj = format!("{}1{}", open_obj, close_obj);

    cases.push(Case {
        name: "unknown_object_depth_256".to_string(),
        raw: BASELINE.replace(
            "\"acknowledgement\":\"ack_1\"",
            &format!("\"acknowledgement\":\"ack_1\",\"extra\":{}", nested_obj),
        ),
    });
    cases.push(Case {
        name: "known_string_object_depth_256".to_string(),
        raw: BASELINE.replace(
            "\"ingress_id\":\"ing_1\"",
            &format!("\"ingress_id\":{}", nested_obj),
        ),
    });

    // 20. nonJSON outer whitespace NEL and BOM
    cases.push(Case {
        name: "outer_whitespace_bom_prefix".to_string(),
        raw: format!("{}{}", "\u{FEFF}", BASELINE),
    });
    cases.push(Case {
        name: "outer_whitespace_bom_suffix".to_string(),
        raw: format!("{}{}", BASELINE, "\u{FEFF}"),
    });
    cases.push(Case {
        name: "outer_whitespace_nel_prefix".to_string(),
        raw: format!("{}{}", "\u{0085}", BASELINE),
    });
    cases.push(Case {
        name: "outer_whitespace_nel_suffix".to_string(),
        raw: format!("{}{}", BASELINE, "\u{0085}"),
    });
    cases.push(Case {
        name: "outer_whitespace_bom_both".to_string(),
        raw: format!("{}{}{}", "\u{FEFF}", BASELINE, "\u{FEFF}"),
    });
    cases.push(Case {
        name: "outer_whitespace_nel_both".to_string(),
        raw: format!("{}{}{}", "\u{0085}", BASELINE, "\u{0085}"),
    });

    // 21. __proto__ and constructor unknown keys
    let proto_constructor_cases: &[(&str, &str)] = &[
        ("unknown_key_proto", r#""acknowledgement":"ack_1","__proto__":"polluted""#),
        ("unknown_key_constructor", r#""acknowledgement":"ack_1","constructor":"polluted""#),
        ("unknown_key_proto_object", r#""acknowledgement":"ack_1","__proto__":{"polluted":true}"#),
        ("unknown_key_constructor_object", r#""acknowledgement":"ack_1","constructor":{"polluted":true}"#),
    ];
    for &(name, repl) in proto_constructor_cases {
        cases.push(Case {
            name: name.to_string(),
            raw: BASELINE.replace("\"acknowledgement\":\"ack_1\"", repl),
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
        }
    }
}
