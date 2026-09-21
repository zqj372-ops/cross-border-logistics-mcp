#!/usr/bin/env python3
import json
import smtplib
import socket
import ssl
import sys
from email.message import EmailMessage

MAX_INPUT = 9 * 1024 * 1024


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        return 64
    try:
        payload = json.loads(raw)
        config = payload["config"]
        message = payload["message"]
        host = config["host"]
        port = config["port"]
        username = config["username"]
        password = config["password"]
        sender = config["from"]
        recipients = [message["to"], *message["cc"]]
        subject = message["subject"]
        body = message["body"]
        if config["secure"] is not True or not isinstance(port, int) or not 1 <= port <= 65535:
            return 64
        if len(recipients) > 11 or len(set(recipients)) != len(recipients):
            return 64
        for value in [sender, subject, *recipients]:
            if not isinstance(value, str) or "\r" in value or "\n" in value:
                return 64
        if not isinstance(body, str):
            return 64
    except Exception:
        return 64

    mail = EmailMessage()
    mail["From"] = sender
    mail["To"] = recipients[0]
    if len(recipients) > 1:
        mail["Cc"] = ", ".join(recipients[1:])
    mail["Subject"] = subject
    mail.set_content(body, subtype="plain", charset="utf-8")
    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, timeout=10, context=context) as smtp:
            smtp.login(username, password)
            refused = smtp.send_message(mail)
            if refused:
                return 65
    except smtplib.SMTPAuthenticationError:
        return 65
    except (smtplib.SMTPSenderRefused, smtplib.SMTPRecipientsRefused, smtplib.SMTPDataError):
        return 65
    except (TimeoutError, socket.timeout):
        return 66
    except (ssl.SSLError, OSError, smtplib.SMTPException):
        return 66
    except Exception:
        return 67
    sys.stdout.write("OK\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
