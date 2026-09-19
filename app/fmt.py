"""Rupee formatting with Indian digit grouping (1,00,000)."""


def inr(value: float, decimals: int = 2) -> str:
    sign = "-" if value < 0 else ""
    whole, _, frac = f"{abs(value):.{decimals}f}".partition(".")
    head, tail = whole[:-3], whole[-3:]
    groups: list[str] = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    body = ",".join([*groups, tail])
    return f"{sign}₹{body}" + (f".{frac}" if decimals else "")
