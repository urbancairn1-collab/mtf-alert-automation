"""Broker credentials and webhook secret: encrypted, write-only, masked on read."""
import re
import secrets
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.crypto import SecretBox, mask
from app.models import BrokerAccount, SettingsRow

_RULES = {
    "client_code": (r"^[A-Za-z0-9]{4,12}$", "Client ID is 4-12 letters or digits (e.g. your Angel login ID)"),
    "api_key": (r"^[A-Za-z0-9]{6,64}$", "Paste the API key from your SmartAPI app"),
    "mpin": (r"^\d{4}$", "MPIN is 4 digits"),
    "totp_secret": (r"^[A-Z2-7]{16,64}$", "TOTP secret is the 16+ character code shown when you enabled TOTP"),
}


@dataclass(frozen=True)
class Credentials:
    client_code: str
    api_key: str
    mpin: str
    totp_secret: str


def _normalise(data: dict) -> dict:
    out = {k: str(data.get(k, "")).strip() for k in _RULES}
    out["totp_secret"] = re.sub(r"\s", "", out["totp_secret"]).upper()
    return out


def validate_credentials(data: dict) -> dict[str, str] | None:
    clean = _normalise(data)
    errors = {k: msg for k, (pat, msg) in _RULES.items() if not re.match(pat, clean[k])}
    return errors or None


def _account(s: Session) -> BrokerAccount:
    acc = s.get(BrokerAccount, 1)
    if acc is None:
        acc = BrokerAccount(id=1)
        s.add(acc)
        s.flush()
    return acc


def save_credentials(s: Session, box: SecretBox, creds: Credentials) -> None:
    c = Credentials(**_normalise(creds.__dict__))
    acc = _account(s)
    acc.client_code = c.client_code
    acc.api_key_enc = box.encrypt(c.api_key)
    acc.mpin_enc = box.encrypt(c.mpin)
    acc.totp_secret_enc = box.encrypt(c.totp_secret)
    acc.last_error = None
    s.flush()


def load_credentials(s: Session, box: SecretBox) -> Credentials | None:
    acc = _account(s)
    if not (acc.client_code and acc.api_key_enc and acc.mpin_enc and acc.totp_secret_enc):
        return None
    return Credentials(acc.client_code, box.decrypt(acc.api_key_enc),
                       box.decrypt(acc.mpin_enc), box.decrypt(acc.totp_secret_enc))


def broker_view(s: Session) -> dict:
    acc = _account(s)
    code = acc.client_code or ""
    return {
        "configured": bool(acc.api_key_enc),
        "client_code_masked": f"{code[:2]}****{code[-2:]}" if code else None,
        "api_key_masked": "********" if acc.api_key_enc else None,
        "last_login_at": acc.last_login_at,
        "session_valid_till": acc.session_valid_till,
        "last_error": acc.last_error,
    }


def _settings_row(s: Session) -> SettingsRow:
    row = s.get(SettingsRow, 1)
    if row is None:
        row = SettingsRow(id=1, data={})
        s.add(row)
        s.flush()
    return row


def get_webhook_secret(s: Session, box: SecretBox) -> str:
    row = _settings_row(s)
    if not row.webhook_secret_enc:
        return rotate_webhook_secret(s, box)
    return box.decrypt(row.webhook_secret_enc)


def rotate_webhook_secret(s: Session, box: SecretBox) -> str:
    secret = f"mtf_{secrets.token_hex(16)}"
    _settings_row(s).webhook_secret_enc = box.encrypt(secret)
    s.flush()
    return secret
