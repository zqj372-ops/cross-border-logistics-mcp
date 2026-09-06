"""Apply FreightClaw's domain-specific appearance after Portal assets deploy.

Run through Authentik's `ak shell`. Existing default and other domain brands,
identity verification, passwords and SMTP credentials are never modified here.
"""
import json

from django.db import transaction
from authentik.brands.models import Brand
from authentik.core.models import Application
from authentik.flows.models import Flow
from authentik.stages.prompt.models import Prompt

css = """
:root, :host {
  --pf-global--FontFamily--text: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --pf-global--FontFamily--heading: var(--pf-global--FontFamily--text);
  --pf-global--primary-color--100: #3659db;
  --pf-global--primary-color--200: #2949c2;
  --ak-color-primary: #3659db;
}
.pf-c-login { background-color: #f6f7fb; }
.pf-c-login__main {
  border: 1px solid #e2e7f0;
  border-radius: 16px;
  box-shadow: 0 10px 40px rgb(32 41 57 / 5%);
  overflow: hidden;
}
.pf-c-login__main-header { padding: 32px 36px 8px; }
.pf-c-login__main-body { padding: 20px 36px 36px; }
.pf-c-login__main-header .pf-c-brand { width: 204px; max-width: 100%; height: auto; }
.pf-c-login__main-header h1 { color: #202939; font-size: 25px; font-weight: 650; line-height: 1.5; }
.pf-c-login__main-header p { color: #697586; font-size: 14px; line-height: 1.7; }
.pf-c-form-control {
  border: 1px solid #cdd5e2;
  border-radius: 8px;
  min-height: 44px;
  background: #fff;
  box-shadow: none;
}
.pf-c-form-control:focus { border-color: #3659db; outline: 3px solid rgb(54 89 219 / 15%); outline-offset: 1px; }
.pf-c-form__label { color: #344054; font-weight: 550; }
.pf-c-button.pf-m-primary { background: #3659db; border-radius: 8px; min-height: 44px; font-weight: 600; }
.pf-c-button.pf-m-primary:hover { background: #2949c2; }
ak-locale-select.pf-m-dark {
  background-color: #344054;
  border: 1px solid #344054;
  border-radius: 8px;
}
ak-locale-select::part(select),
ak-locale-select select,
select.ak-m-capitalize {
  color: #344054 !important;
  background-color: #fff !important;
  border: 1px solid #cdd5e2;
  border-radius: 8px;
  min-height: 36px;
  padding: 0 30px 0 10px;
}
ak-locale-select::part(select):focus,
ak-locale-select select:focus,
select.ak-m-capitalize:focus {
  border-color: #3659db;
  outline: 3px solid rgb(54 89 219 / 15%);
  outline-offset: 1px;
}
.pf-c-login__footer { display: none; }
@media (max-width: 600px) {
  .pf-c-login__main-header { padding: 24px 24px 8px; }
  .pf-c-login__main-body { padding: 16px 24px 28px; }
  .pf-c-login__main { border-radius: 12px; }
}
"""

with transaction.atomic():
    authentication = Flow.objects.get(slug='freightclaw-cn-authentication')
    application = Application.objects.get(slug='freightclaw-portal')
    brand, _ = Brand.objects.get_or_create(domain='www.freightclaw.net', defaults={'default': False})
    attributes = dict(brand.attributes or {})
    settings = dict(attributes.get('settings') or {})
    settings['locale'] = 'zh-Hans'
    settings['theme'] = {**dict(settings.get('theme') or {}), 'base': 'light'}
    attributes['settings'] = settings
    brand.branding_title = 'FreightClaw 工作台'
    brand.branding_logo = 'https://www.freightclaw.net/console/brand-wordmark.svg'
    brand.branding_favicon = 'https://www.freightclaw.net/console/brand-icon.svg'
    brand.branding_default_flow_background = 'https://www.freightclaw.net/console/auth-background.svg'
    brand.branding_custom_css = css
    brand.flow_authentication = authentication
    brand.default_application = application
    brand.attributes = attributes
    brand.save()
    Prompt.objects.filter(name='FreightClaw 注册邮箱').update(label='邮箱')

print('RESULT ' + json.dumps({'domain': brand.domain, 'title': brand.branding_title, 'locale': 'zh-Hans', 'other_brands_changed': False, 'identity_credentials_changed': False}, ensure_ascii=False))
