# Unapplied PR5 integration candidates

791 borrowed transaction validates original receipt, exact ended proof, binding and fences, cancels only original jobs, settles matching async execution, preserves previous proof and validates holds/receipt/final retained record before caller commit. Focused30PASS. Caller must own IMMEDIATE transaction and native lifetime; helper does not commit or rollback. Whole8327 expected is still running.

792 native Stop observer reuses one real admission,10s lifetime and per-request<=2s. Stop mode requests notLoaded compact turns and requires all encountered turns ended, permits idle/notLoaded metadata; default general recovery remains full/idle-only. Focused27PASS, actual native child tests included. Initial26/27 fixture failure was undefined JSON property rejected before intended predicate; corrected fixture to omitted field, source untouched. Raw RED retained locally.

793 withUnsealed requires live permit and unsealed gate, bounded synchronous void callback, no await. Reentrant same-gate operations fail closed rather than Rust mutex deadlock; no cross-thread mutex equivalence claimed. Initial22/23 exposed release setting disposed before reentry refusal; guard moved before mutation. Same test then23PASS. Initial RED retained. No deployment/runtime loop integration.
