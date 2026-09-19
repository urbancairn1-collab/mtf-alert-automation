import pytest

from app.db import init_db, make_engine, session_scope


@pytest.fixture
def engine(tmp_path):
    eng = make_engine(tmp_path / "test.db")
    init_db(eng)
    return eng


@pytest.fixture
def session(engine):
    with session_scope(engine) as s:
        yield s
