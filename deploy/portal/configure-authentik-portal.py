"""Run through `ak shell` in the existing Authentik instance after a backup.
Creates only the dedicated Portal OIDC application and role groups. Does not set
human passwords, verify email addresses, create people, or change legacy apps.
The generated confidential client secret stays in a protected server-side file.
"""
import json
import os
import secrets
from pathlib import Path
from django.db import transaction
from authentik.core.models import Application, Group, User
from authentik.crypto.models import CertificateKeyPair
from authentik.flows.models import Flow
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping

SLUG = 'freightclaw-portal'
CLIENT_ID = 'freightclaw-portal-production'
CALLBACK = 'https://www.freightclaw.net/console/auth/callback'
SECRET_FILE = Path('/data/freightclaw-portal-oidc-client.secret')
GROUP_OPERATOR = 'freightclaw-platform-operators'
GROUP_REVIEWER = 'freightclaw-platform-reviewers'

with transaction.atomic():
    operator, _ = Group.objects.get_or_create(name=GROUP_OPERATOR, defaults={'is_superuser': False})
    Group.objects.get_or_create(name=GROUP_REVIEWER, defaults={'is_superuser': False})
    # Existing Authentik administrator remains the platform operator, not a
    # customer-organization member. Password/email verification are unchanged.
    admin = User.objects.get(username='akadmin', is_active=True)
    operator.users.add(admin)
    email_mapping, _ = ScopeMapping.objects.update_or_create(
        name='FreightClaw Portal verified email',
        defaults={'scope_name': 'email', 'description': 'Verified directory email only',
                  'expression': 'return {"email": request.user.email, "email_verified": request.user.attributes.get("email_verified") is True}'}
    )
    profile_mapping, _ = ScopeMapping.objects.update_or_create(
        name='FreightClaw Portal profile',
        defaults={'scope_name': 'profile', 'description': 'Directory identity and Portal role groups',
                  'expression': 'return {"name": request.user.name, "preferred_username": request.user.username, "groups": [g.name for g in request.user.groups.all() if g.name in ["freightclaw-platform-operators", "freightclaw-platform-reviewers"]]}'}
    )
    provider = OAuth2Provider.objects.filter(name=SLUG).first()
    if provider and (provider.client_id != CLIENT_ID or provider.client_type != 'confidential'):
        raise RuntimeError('existing_portal_provider_configuration_conflict')
    if provider is None:
        provider = OAuth2Provider(name=SLUG, client_id=CLIENT_ID, client_type='confidential', client_secret=secrets.token_urlsafe(48))
    provider.authorization_flow = Flow.objects.get(slug='default-provider-authorization-implicit-consent')
    provider.invalidation_flow = Flow.objects.get(slug='default-provider-invalidation-flow')
    provider.authentication_flow = Flow.objects.get(slug='default-authentication-flow')
    provider.signing_key = CertificateKeyPair.objects.get(name='authentik Self-signed Certificate')
    provider._redirect_uris = [{'url': CALLBACK, 'matching_mode': 'strict', 'redirect_uri_type': 'authorization'}]
    provider.grant_types = ['authorization_code']
    provider.access_code_validity = 'minutes=2'
    provider.access_token_validity = 'minutes=5'
    provider.include_claims_in_id_token = True
    provider.issuer_mode = 'per_provider'
    provider.sub_mode = 'user_uuid'
    provider.save()
    openid = ScopeMapping.objects.get(managed='goauthentik.io/providers/oauth2/scope-openid')
    provider.property_mappings.set([openid, email_mapping, profile_mapping])
    app, _ = Application.objects.get_or_create(slug=SLUG, defaults={'name': 'FreightClaw 工作台'})
    if app.provider_id not in (None, provider.pk):
        raise RuntimeError('existing_portal_application_conflict')
    app.provider = provider
    app.name = 'FreightClaw 工作台'
    app.meta_launch_url = 'https://www.freightclaw.net/console/'
    app.save()
    if SECRET_FILE.exists():
        if SECRET_FILE.is_symlink() or SECRET_FILE.read_text().strip() != provider.client_secret:
            raise RuntimeError('portal_client_secret_file_conflict')
    else:
        fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        with os.fdopen(fd, 'w') as target:
            target.write(provider.client_secret)
    os.chmod(SECRET_FILE, 0o400)
print('RESULT ' + json.dumps({'application': SLUG, 'client_id': CLIENT_ID, 'callback': CALLBACK,
                            'signing_key_configured': provider.signing_key_id is not None,
                            'secret_file_present': SECRET_FILE.is_file(),
                            'operator_group_assigned': operator.users.filter(pk=admin.pk).exists(),
                            'human_email_verified': admin.attributes.get('email_verified') is True,
                            'human_password_usable': admin.has_usable_password()}))
