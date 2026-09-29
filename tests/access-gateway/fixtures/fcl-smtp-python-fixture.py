import importlib.util
import io
import json
import sys


def load(path):
    spec = importlib.util.spec_from_file_location("fcl_smtp_send_fixture", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeSMTP:
    def __init__(self, refused):
        self.refused = refused
        self.logged_in = False
        self.sent = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def ehlo(self):
        pass

    def starttls(self, context):
        self.tls = True

    def login(self, username, password):
        assert self.tls
        assert username == "sender@example.test"
        assert password == "private-password"
        self.logged_in = True

    def send_message(self, message):
        assert message["To"] == "receiver@example.test"
        assert str(message["From"]) == "Freightclaw-FCL <sender@example.test>"
        self.sent += 1
        return self.refused


def run(module, refused, secure=True):
    payload = {
        "config": {
            "host": "smtp.example.test",
            "port": 465,
            "secure": secure,
            "username": "sender@example.test",
            "password": "private-password",
            "from": "sender@example.test",
            "from_name": "Freightclaw-FCL",
        },
        "message": {
            "to": "receiver@example.test",
            "cc": ["copy@example.test"],
            "subject": "合成询价",
            "body": "private body must not be reflected",
        },
    }
    fake = FakeSMTP(refused)
    fake.tls = secure
    module.PublicSMTP = lambda *_args, **_kwargs: fake
    module.PublicSMTPSSL = lambda *_args, **_kwargs: fake
    module.ssl.create_default_context = lambda: object()
    sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode("utf-8")))
    output = io.StringIO()
    sys.stdout = output
    code = module.main()
    assert fake.logged_in and fake.sent == 1
    assert "private-password" not in output.getvalue()
    assert "private body" not in output.getvalue()
    return code, output.getvalue()


module = load(sys.argv[1])
assert run(module, {}) == (0, "OK\n")
assert run(module, {}, False) == (0, "OK\n")
assert run(module, {"receiver@example.test": (550, b"rejected")})[0] == 68

# Resolve once, reject local/private/mixed destinations before opening a socket.
for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '224.0.0.1']:
    module.socket.getaddrinfo = lambda *args, **kwargs: [(2, 1, 6, '', (address, 465))]
    try:
        module.public_socket('smtp.test', 465, 1)
        raise AssertionError('private destination accepted')
    except OSError:
        pass
