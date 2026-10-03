#!/usr/bin/env python3
"""Build the restricted runtime role's DATABASE_URL from a template URL.

Used by scripts/r3-provision-and-verify.zsh (docs/adr/0053, R3). The template
is the CURRENT DATABASE_URL: the result keeps its scheme, host, port, database
path, query and fragment, and swaps the credentials:

  - user: <role>.<project_ref> when the template user is Supabase-pooler style
    ("postgres.<project_ref>"), otherwise just <role>;
  - password: the new one, percent-encoded (RFC 3986 userinfo), so reserved
    characters such as @ : / ? # % can never change how the URL is parsed.

Inputs come from the environment (never argv, never printed):
  TEMPLATE_URL, APP_ROLE, APP_PW
Flags:
  --no-query   drop the query and fragment (psql rejects Prisma-only
               parameters such as ?pgbouncer=true / ?schema=public).

Prints exactly one URL on success. On any problem, prints a message that
never contains a URL or a credential to stderr and exits 2. The result is
re-parsed before it is printed: it must round-trip to the exact password,
user, host, port and database, or nothing is printed.
"""

import os
import sys
from urllib.parse import quote, unquote, urlsplit, urlunsplit

POSTGRES_SCHEMES = ("postgres", "postgresql")


class RoleUrlError(ValueError):
    """Invalid input. The message never contains a URL or a credential."""


def normalize_template(raw: str) -> str:
    """Tolerate the shapes a URL takes when copied from an env file / dashboard:
    surrounding whitespace, a KEY= prefix, matching surrounding quotes."""
    s = (raw or "").strip()
    head = s.split("://", 1)[0]
    if "=" in head:  # e.g. DATABASE_URL="postgresql://…"
        s = s.split("=", 1)[1].strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1].strip()
    return s


def build_role_url(template: str, role: str, password: str, include_query: bool = True) -> str:
    if not role:
        raise RoleUrlError("APP_ROLE is empty")
    if not password:
        raise RoleUrlError("APP_PW is empty")

    t = urlsplit(normalize_template(template))
    if t.scheme.lower() not in POSTGRES_SCHEMES:
        raise RoleUrlError("the template is not a postgres / postgresql URL")
    if not t.hostname:
        raise RoleUrlError("the template has no host")
    try:
        port = t.port
    except ValueError:
        raise RoleUrlError("the template has an invalid port") from None
    if not t.username:
        raise RoleUrlError("the template has no user name")

    template_user = unquote(t.username)
    project_ref = template_user.split(".", 1)[1] if "." in template_user else ""
    new_user = f"{role}.{project_ref}" if project_ref else role

    host = t.hostname
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    netloc = f"{quote(new_user, safe='')}:{quote(password, safe='')}@{host}"
    if port is not None:
        netloc += f":{port}"

    url = urlunsplit((
        t.scheme,
        netloc,
        t.path,
        t.query if include_query else "",
        t.fragment if include_query else "",
    ))

    # Round-trip proof: never hand back a URL that does not parse to exactly
    # what was intended.
    r = urlsplit(url)
    if (
        r.scheme != t.scheme
        or r.password is None or unquote(r.password) != password
        or r.username is None or unquote(r.username) != new_user
        or r.hostname != t.hostname
        or r.port != port
        or r.path != t.path
    ):
        raise RoleUrlError("internal error: the generated URL does not round-trip")
    return url


def main(argv: list[str]) -> int:
    include_query = "--no-query" not in argv[1:]
    try:
        print(build_role_url(
            os.environ.get("TEMPLATE_URL", ""),
            os.environ.get("APP_ROLE", ""),
            os.environ.get("APP_PW", ""),
            include_query=include_query,
        ))
    except RoleUrlError as error:
        print(f"build-role-url: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
