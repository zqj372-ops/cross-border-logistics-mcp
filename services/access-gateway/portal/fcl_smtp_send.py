#!/usr/bin/env python3
import base64
import json
import ipaddress
import smtplib
import socket
import ssl
import sys
from email.message import EmailMessage
from email.headerregistry import Address

MAX_INPUT = 9 * 1024 * 1024


def public_socket(host, port, timeout):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global or ipaddress.ip_address(item[4][0]).is_multicast for item in addresses):
        raise OSError("smtp_destination_not_public")
    return socket.create_connection((addresses[0][4][0], port), timeout)


class PublicSMTP(smtplib.SMTP):
    def _get_socket(self, host, port, timeout):
        return public_socket(host, port, timeout)


class PublicSMTPSSL(smtplib.SMTP_SSL):
    def _get_socket(self, host, port, timeout):
        raw = public_socket(host, port, timeout)
        try:
            return self.context.wrap_socket(raw, server_hostname=host)
        except Exception:
            raw.close()
            raise


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
        sender_name = config.get("from_name", "")
        recipients = [message["to"], *message["cc"]]
        subject = message["subject"]
        body = message["body"]
        if not isinstance(config["secure"], bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            return 64
        if len(recipients) > 11 or len(set(recipients)) != len(recipients):
            return 64
        for value in [sender_name, sender, subject, *recipients, *([config["reply_to"]] if config.get("reply_to") else [])]:
            if not isinstance(value, str) or "\r" in value or "\n" in value:
                return 64
        if not isinstance(body, str):
            return 64
    except Exception:
        return 64

    mail = EmailMessage()
    mail["From"] = Address(display_name=sender_name, addr_spec=sender)
    mail["To"] = recipients[0]
    if config.get("reply_to"):
        mail["Reply-To"] = config["reply_to"]
    if len(recipients) > 1:
        mail["Cc"] = ", ".join(recipients[1:])
    mail["Subject"] = subject
    mail.set_content(body, subtype="plain", charset="utf-8")
    try:
        attachments = message.get("attachments", [])
        if len(attachments) > 5:
            return 64
        for item in attachments:
            name = item["filename"]
            if not name or any(ord(c) < 32 or c in "/\\" for c in name):
                return 64
            maintype, subtype = item["content_type"].split("/", 1)
            mail.add_attachment(base64.b64decode(item["content_base64"], validate=True), maintype=maintype, subtype=subtype, filename=name)
    except Exception:
        return 64
    try:
        context = ssl.create_default_context()
        with (PublicSMTPSSL(host, port, timeout=10, context=context) if config["secure"] else PublicSMTP(host, port, timeout=10)) as smtp:
            if not config["secure"]:
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
            smtp.login(username, password)
            refused = smtp.send_message(mail)
            if refused:
                # Some RCPT recipients may already have accepted DATA. Never retry
                # the whole group as an ordinary definitive rejection.
                return 68
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
