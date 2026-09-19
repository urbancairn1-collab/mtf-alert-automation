import pytest

from app.crypto import SecretBox, mask
from app.models import BrokerAccount
from app.repo_broker import (Credentials, broker_view, get_webhook_secret, load_credentials,
                             rotate_webhook_secret, save_credentials, validate_credentials)

GOOD = {"client_code": "A123456", "api_key": "abcDEF123", "mpin": "1234",
        "totp_secret": "JBSWY3DPEHPK3PXP"}


@pytest.fixture
def box(tmp_path):
    return SecretBox(tmp_path / "secret.key")


def test_round_trip_and_key_reuse(tmp_path):
    token = SecretBox(tmp_path / "k").encrypt("hello")
    assert SecretBox(tmp_path / "k").decrypt(token) == "hello"


def test_mask():
    assert mask("mtf_4f9a2c7e81d3b6") == "**************d3b6"


def test_validation_messages():
    assert validate_credentials(GOOD) is None
    bad = validate_credentials({**GOOD, "mpin": "12a4", "totp_secret": "short"})
    assert set(bad) == {"mpin", "totp_secret"}


def test_credentials_are_encrypted_at_rest(session, box):
    save_credentials(session, box, Credentials(**GOOD))
    row = session.get(BrokerAccount, 1)
    assert "1234" not in (row.mpin_enc or "")
    assert load_credentials(session, box) == Credentials(**GOOD)


def test_broker_view_never_leaks_secrets(session, box):
    save_credentials(session, box, Credentials(**GOOD))
    view = broker_view(session)
    assert view["configured"] is True
    assert view["client_code_masked"] == "A1****56"
    assert "1234" not in str(view) and "JBSWY" not in str(view)


def test_webhook_secret_created_once_then_rotated(session, box):
    first = get_webhook_secret(session, box)
    assert first == get_webhook_secret(session, box)
    assert first.startswith("mtf_")
    import re
    assert re.match(r"^mtf_[0-9a-f]{32}$", first)
    rotated = rotate_webhook_secret(session, box)
    assert rotated != first
    assert re.match(r"^mtf_[0-9a-f]{32}$", rotated)


def test_key_file_created_once_and_reused(tmp_path):
    key_path = tmp_path / "sub" / "k"
    box1 = SecretBox(key_path)
    assert key_path.exists()
    key_bytes = key_path.read_bytes()

    box2 = SecretBox(key_path)
    assert key_path.read_bytes() == key_bytes

    token = box1.encrypt("secret")
    assert box2.decrypt(token) == "secret"
