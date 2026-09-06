"""Rollback-only Authentik 2026.8 semantic verification for FreightClaw CN flows."""
import json, uuid
from django.db import transaction
from authentik.core.models import User
from authentik.flows.models import Flow, FlowStageBinding, FlowToken
from authentik.flows.planner import FlowPlan
from authentik.policies.expression.models import ExpressionPolicy
from authentik.policies.types import PolicyRequest

with transaction.atomic():
    auth=Flow.objects.get(slug='freightclaw-cn-authentication')
    enroll=Flow.objects.get(slug='freightclaw-cn-enrollment')
    recovery=Flow.objects.get(slug='freightclaw-cn-recovery')
    policy=ExpressionPolicy.objects.get(name='FreightClaw 邮箱验证完成')
    marker=FlowStageBinding.objects.get(target=auth,stage__name='FreightClaw 写入邮箱验证状态')
    user=User.objects.create(username='flow-check-'+uuid.uuid4().hex,email='flow-check@example.invalid',name='Flow Check',is_active=True,attributes={'email_verified':False})
    other=User.objects.create(username='flow-other-'+uuid.uuid4().hex,email='flow-other@example.invalid',name='Flow Other',is_active=True,attributes={'email_verified':False})
    def make_token(flow, owner):
        plan=FlowPlan(flow_pk=flow.pk)
        return FlowToken.objects.create(identifier='flow-check-'+uuid.uuid4().hex,user=owner,flow=flow,_plan=FlowToken.pickle(plan))
    def run(pending, token):
        request=PolicyRequest(pending)
        request.context={'pending_user':pending}
        if token is not None: request.context['is_restored']=token
        request.obj=marker
        result=policy.passes(request)
        pending.refresh_from_db()
        return bool(result.passing), pending.attributes.get('email_verified') is True
    cases={}
    cases['missing_token']=run(user,None)
    valid=make_token(auth,user)
    cases['matching_token']=run(user,valid)
    user.attributes={'email_verified':False}; user.save(update_fields=['attributes'])
    cases['wrong_user']=run(user,make_token(auth,other))
    cases['wrong_flow']=run(user,make_token(recovery,user))
    user.is_active=False; user.save(update_fields=['is_active']); cases['inactive_user']=run(user,valid)
    orders={flow.slug:[(b.order,b.stage.name,b.policy_engine_mode,b.evaluate_on_plan) for b in FlowStageBinding.objects.filter(target=flow).order_by('order')] for flow in (auth,enroll,recovery)}
    assertions={
      'all_binding_modes':all(mode=='all' for rows in orders.values() for _,_,mode,_ in rows),
      'all_runtime_evaluation':all(plan is False for rows in orders.values() for *_,plan in rows),
      'enrollment_write_before_email':next(o for o,n,_,_ in orders[enroll.slug] if n=='FreightClaw 创建邮箱用户') < next(o for o,n,_,_ in orders[enroll.slug] if n=='FreightClaw 验证企业邮箱'),
      'missing_token_blocked':cases['missing_token']==(False,False),
      'matching_token_marks':cases['matching_token']==(True,True),
      'wrong_user_blocked':cases['wrong_user']==(False,False),
      'wrong_flow_blocked':cases['wrong_flow']==(False,False),
      'inactive_blocked':cases['inactive_user']==(False,False),
    }
    print(json.dumps({'orders':orders,'cases':cases,'assertions':assertions,'all_pass':all(assertions.values())},sort_keys=True))
    transaction.set_rollback(True)
