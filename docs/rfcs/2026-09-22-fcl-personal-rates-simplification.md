# FCL personal accounts and separate ocean/ancillary maintenance

Status: accepted for implementation by the user's explicit 2026-09-22 specification. This changes the existing FCL Portal, native quotation and document contracts; it is not a new module or a production migration approval.

## Identity and ownership

FCL staff actions use the authenticated, email-verified account as owner, regardless of the unrelated enterprise selection in the Portal. Existing `fcl-person:<user>` rate scopes and personal document/case owner columns remain the isolation boundary. The configured public inquiry receiver remains the recipient of anonymous submissions; opening personal access does not reassign those submissions. Enterprise records retain their organization and business information. No inferred company-to-person mapping is made. Unmapped legacy organization records require an explicit owner reconciliation before a later migration.

Normal session, CSRF, idempotency, object ownership, source publication and document review checks remain. Existing CLI staff commands use the same HTTP service. Application keys and the unrelated enterprise MCP catalogue acquire no new writing permissions; FCL has no separately registered public MCP write tool.

## Maintenance contracts and calculation

The v1/v2 dataset readers accept optional nullable `valid_from`/`valid_until` for ocean rates, charges and fee templates. Supplied historical fields remain serialized unchanged, but no longer select or expire these records. No replacement expiry is generated. `updated_at` is optional server-maintained metadata; missing historical timestamps stay unknown; clearing old date metadata does not make an unchanged price look newly updated. Delivery-rate windows remain independent and unchanged. Formal customer quote dates remain required and checked against that document's own dates.

Old maintenance JSON: `{valid_from:"2026-10-01",valid_until:"2026-10-31",...}`. New JSON omits both fields. Calculation/source binding dates may be null when no remaining dated delivery component exists. Historical snapshots and digests are never rewritten.

Ocean items in the selected rate are the only base ocean source. Ancillary charges such as EMF and ISPS remain legitimate even when categorized as ocean. Exact known base-freight names/codes are identified separately. Legacy base-freight charges are preserved and block use until explicitly resolved. Optional `ocean_freight_resolution:{action:"exclude",reason:string}` records that confirmation on the retained charge, with the normal configuration audit and immutable publication history. No unresolved nonzero charge is silently discarded. New base freight is not entered in the template UI. Missing container prices remain blockers, never an inferred zero.

Unrelated existing source fees retain their evidence and amounts; collisions with template fees require review. This avoids removing a nonzero historical fee merely because its old maintenance location changed.

## Compatibility, tests and rollback

Existing versioned objects without new fields serialize identically. Additive schema changes are generated for HTTP, native and document contracts together; the old strict binary cannot read new null source dates, so rollback requires the prior complete database backup or a compatible reader. Do not restore only rate configuration over new document history.

Test independent authenticated accounts and negative cross-account reads/replays, enterprise-selection independence, no-date save/publication/calculation, expired historical rates, ocean duplication and explicit exclusion, missing rates, source changes/new estimates and immutable historical snapshots. Run schema/agent checks, related tests, typecheck/build and actual fixture browser flows with screenshots. Production status is reported separately.

登录后新增 `case-create` 窄动作，复用当前 inquiry/case 对象和提交事务，服务端从会话绑定 owner，CLI 共享同一输入和响应 Schema。原因：仅开放运价权限会导致其他个人账号没有可受理询价，不能完成正式报价。录入后读回本人案例；幂等按个人隔离；不通知客户、不改变公开提交固定受理人的行为，也不返回匿名恢复凭证。新增个人账号不再依赖公开受理人身份服务的可用性，正常 Portal 会话鉴权仍必须成功。
