#!/usr/bin/env python3
"""SatObserver-MX backend.

Static file server for app/ plus a small JSON API for TLE fetching
(CelesTrak, Space-Track, McCants), a TLE cache browser, and state
persistence. Python 3.13 standard library only.
"""

import argparse
import datetime
import hashlib
import math
import http.cookiejar
import http.server
import io
import json
import os
import pathlib
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from email.utils import formatdate

VERSION = "0.1.0"
USER_AGENT = "SatObserverMX/0.1"
FETCH_TIMEOUT = 30          # seconds, all outbound HTTP
CACHE_FRESH_S = 2 * 3600    # CelesTrak disk cache considered fresh below this age

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
# When frozen by PyInstaller, static assets live in the bundle (sys._MEIPASS)
# and user data must NOT be written inside the .app — use Application Support.
IS_BUNDLED = bool(getattr(sys, "_MEIPASS", None))
BASE_DIR = pathlib.Path(getattr(sys, "_MEIPASS", None) or SCRIPT_DIR)
APP_DIR = (BASE_DIR / "app").resolve()
if IS_BUNDLED:
    if sys.platform == "darwin":
        DATA_DIR = pathlib.Path.home() / "Library" / "Application Support" / "SatObserverMX"
    elif os.name == "nt":
        DATA_DIR = pathlib.Path(os.environ.get("APPDATA") or pathlib.Path.home()) / "SatObserverMX"
    else:
        DATA_DIR = pathlib.Path.home() / ".local" / "share" / "SatObserverMX"
else:
    DATA_DIR = SCRIPT_DIR / "data"
CACHE_DIR = DATA_DIR / "cache"
STATE_PATH = DATA_DIR / "state.json"
CONFIG_PATH = DATA_DIR / "config.json"

DEFAULT_PORT = 8474
PORT_TRIES = 11  # 8474..8484

# JSON (OMM) format: NORAD_CAT_ID is a full integer, unlike 5-char TLE fields
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
CELESTRAK_CATNR_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=json"
SUPGP_URL = ("https://celestrak.org/NORAD/elements/supplemental/"
             "sup-gp.php?FILE={file}&FORMAT=json")
SUPGP_INDEX_URL = "https://celestrak.org/NORAD/elements/supplemental/"
SATCAT_URL = "https://celestrak.org/satcat/records.php?CATNR={norad}&FORMAT=JSON"
SATCAT_FRESH_S = 30 * 86400   # SATCAT records are near-static; refresh monthly
SPACETRACK_BASE = "https://www.space-track.org"
SPACETRACK_LOGIN = SPACETRACK_BASE + "/ajaxauth/login"

CELESTRAK_GROUPS = [
    ("stations", "Space Stations"),
    ("visual", "100 Brightest (Visual)"),
    ("last-30-days", "Last 30 Days' Launches"),
    ("active", "Active Satellites"),
    ("weather", "Weather"),
    ("noaa", "NOAA"),
    ("resource", "Earth Resources"),
    ("gps-ops", "GPS Operational"),
    ("glonass-ops", "GLONASS Operational"),
    ("galileo", "Galileo"),
    ("beidou", "BeiDou"),
    ("sbas", "SBAS"),
    ("amateur", "Amateur Radio"),
    ("starlink", "Starlink"),
    ("oneweb", "OneWeb"),
    ("iridium-NEXT", "Iridium NEXT"),
    ("globalstar", "Globalstar"),
    ("intelsat", "Intelsat"),
    ("ses", "SES"),
    ("geo", "Geostationary"),
    ("science", "Space & Earth Science"),
    ("cubesat", "CubeSats"),
    ("military", "Miscellaneous Military"),
    ("radar", "Radar Calibration"),
    ("tle-new", "Recently Added (TLE-NEW)"),
]

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}

CACHE_KEY_RE = re.compile(r"[A-Za-z0-9_.-]+\Z")
SUPGP_FILE_RE = re.compile(r"[A-Za-z0-9.-]{1,60}\Z")   # sup-gp.php FILE names
GROUP_ID_RE = re.compile(r"[A-Za-z0-9_-]+\Z")

_IO_LOCK = threading.Lock()  # serializes writes to data/ (replace() itself is atomic)


class ApiError(Exception):
    """Deliberate API failure with an HTTP status code."""

    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


# ---------------------------------------------------------------------------
# TLE parsing
# ---------------------------------------------------------------------------

_ALPHA5 = {c: 10 + i for i, c in enumerate("ABCDEFGHJKLMNPQRSTUVWXYZ")}


def catnum(field):
    """Decode a TLE catalog-number field (columns 3-7): plain digits or
    Alpha-5 (leading letter A-Z minus I/O encodes 10-33, e.g. 'A1234' = 101234).
    Returns int or None."""
    f = field.strip()
    try:
        if f and f[0].isalpha():
            return _ALPHA5[f[0].upper()] * 10000 + int(f[1:])
        return int(f)
    except (ValueError, KeyError):
        return None


def parse_tles(text):
    """Parse TLE text into [{name, l1, l2, norad}, ...].

    Accepts 3-line sets (name / l1 / l2), bare 2-line sets (name becomes
    "OBJECT <norad>"), McCants-style '0 NAME' name lines, and Alpha-5
    catalog numbers. Malformed pairs (wrong line numbers, mismatched or
    undecodable catalog numbers) are skipped; orphaned '1 '/'2 ' data lines
    are dropped rather than mistaken for names. Tolerates \r\n, trailing
    whitespace and blank lines.
    """
    out = []
    lines = [ln.rstrip() for ln in text.splitlines()]
    pending_name = None
    i, n = 0, len(lines)
    while i < n:
        ln = lines[i]
        if not ln.strip():
            i += 1
            continue
        if ln.startswith("1 "):
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            if j < n and lines[j].startswith("2 "):
                l1, l2 = ln, lines[j]
                n1, n2 = catnum(l1[2:7]), catnum(l2[2:7])
                if n1 is not None and n1 == n2:
                    name = (pending_name or f"OBJECT {n1}").strip()
                    out.append({"name": name, "l1": l1, "l2": l2, "norad": n1})
                pending_name = None
                i = j + 1
                continue
        # An orphaned element line (a '1 ' missing its '2 ', or a stray '2 ')
        # must not become the next satellite's name.
        if ln[:2] in ("1 ", "2 ") and len(ln) > 60:
            pending_name = None
            i += 1
            continue
        name = ln.strip()
        if name.startswith("0 "):  # McCants style
            name = name[2:].strip()
        pending_name = name or None
        i += 1
    return out


# ---------------------------------------------------------------------------
# OMM (JSON) -> TLE lines
#
# The catalog passed 100000 in 2026: FORMAT=tle caps out (Alpha-5 encodes only
# 100000-339999), so CelesTrak/Space-Track are fetched as JSON (full integer
# NORAD_CAT_ID + all mean elements) and TLE lines for the SGP4 pipeline are
# taken from the record when present, else synthesized here.
# ---------------------------------------------------------------------------

_ALPHA5_REV = "ABCDEFGHJKLMNPQRSTUVWXYZ"


def catnum5(n):
    """5-char TLE catalog field: plain digits, Alpha-5, or '00000' beyond range."""
    if n <= 99999:
        return f"{n:05d}"
    if n <= 339999:
        return _ALPHA5_REV[n // 10000 - 10] + f"{n % 10000:04d}"
    return "00000"  # unrepresentable in TLE; propagation does not need it


def _tle_epoch(iso):
    """ISO epoch -> 'YYDDD.DDDDDDDD'."""
    s = str(iso).strip().rstrip("Z")
    if "." in s:
        base, frac = s.split(".", 1)
        fsec = float("0." + frac)
    else:
        base, fsec = s, 0.0
    dt = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S")
    doy = dt.timetuple().tm_yday
    dayfrac = (dt.hour * 3600 + dt.minute * 60 + dt.second + fsec) / 86400.0
    frac8 = min(round(dayfrac * 1e8), 99999999)
    return f"{dt.year % 100:02d}{doy:03d}.{frac8:08d}"


def _tle_dec8(x):
    """Signed decimal field (ndot/2): ' .00016717' / '-.00016717'."""
    x = float(x or 0)
    v = min(round(abs(x) * 1e8), 99999999)
    return ("-" if x < 0 else " ") + "." + f"{v:08d}"


def _tle_exp(x):
    """TLE exponent field (nddot/6, bstar): ' 34123-4' (implied leading point)."""
    x = float(x or 0)
    if x == 0:
        return " 00000+0"
    sign = "-" if x < 0 else " "
    ax = abs(x)
    exp = int(math.floor(math.log10(ax))) + 1
    mant = round(ax / (10.0 ** exp) * 1e5)
    if mant >= 100000:
        mant //= 10
        exp += 1
    exp = max(-9, min(9, exp))
    return f"{sign}{mant:05d}{exp:+d}"


def _tle_checksum(line):
    s = 0
    for ch in line:
        if ch.isdigit():
            s += int(ch)
        elif ch == "-":
            s += 1
    return str(s % 10)


def omm_to_tle(rec):
    """Build (line1, line2) from a CCSDS OMM record (CelesTrak/Space-Track JSON)."""
    norad = int(rec["NORAD_CAT_ID"])
    cat = catnum5(norad)
    cls = (rec.get("CLASSIFICATION_TYPE") or "U")[:1]
    intl = ""
    m = re.match(r"^(\d{4})-(\d{3})([A-Z]*)\s*$", str(rec.get("OBJECT_ID") or ""))
    if m:
        intl = f"{int(m.group(1)) % 100:02d}{m.group(2)}{m.group(3)}"
    intl = intl[:8].ljust(8)
    elset = int(float(rec.get("ELEMENT_SET_NO") or 999)) % 10000
    l1 = (f"1 {cat}{cls} {intl} {_tle_epoch(rec['EPOCH'])} "
          f"{_tle_dec8(rec.get('MEAN_MOTION_DOT'))} {_tle_exp(rec.get('MEAN_MOTION_DDOT'))} "
          f"{_tle_exp(rec.get('BSTAR'))} 0 {elset:4d}")
    l1 += _tle_checksum(l1)
    ecc = f"{min(round(float(rec['ECCENTRICITY']) * 1e7), 9999999):07d}"
    rev = int(float(rec.get("REV_AT_EPOCH") or 0)) % 100000
    l2 = (f"2 {cat} {float(rec['INCLINATION']):8.4f} {float(rec['RA_OF_ASC_NODE']):8.4f} "
          f"{ecc} {float(rec['ARG_OF_PERICENTER']):8.4f} {float(rec['MEAN_ANOMALY']):8.4f} "
          f"{float(rec['MEAN_MOTION']):11.8f}{rev:5d}")
    l2 += _tle_checksum(l2)
    return l1, l2


def omm_records_to_tles(records):
    """OMM JSON array -> [{name, l1, l2, norad}] (norad is the full integer)."""
    out = []
    for rec in records:
        try:
            norad = int(rec["NORAD_CAT_ID"])
            l1 = (rec.get("TLE_LINE1") or "").strip()
            l2 = (rec.get("TLE_LINE2") or "").strip()
            if not (l1.startswith("1 ") and l2.startswith("2 ")):
                l1, l2 = omm_to_tle(rec)
            out.append({"name": (rec.get("OBJECT_NAME") or f"OBJECT {norad}").strip(),
                        "l1": l1, "l2": l2, "norad": norad})
        except Exception:
            continue  # skip malformed records
    return out


def _iso_unix(s):
    """OMM EPOCH string (UTC, no zone suffix) -> unix seconds; 0.0 on failure."""
    try:
        return (datetime.datetime.fromisoformat(str(s).strip().rstrip("Zz"))
                .replace(tzinfo=datetime.timezone.utc).timestamp())
    except ValueError:
        return 0.0


SUPGP_SEG_RE = re.compile(r"\s*\[Segment\s*\d+\]\s*$", re.I)


def supgp_records_to_tles(records):
    """SupGP OMM records -> one entry per object.

    Supplemental files may carry several piecewise-fitted TLE 'segments' per
    object (e.g. "CSS [Segment 03]"), each best near its own epoch, epochs
    often extending into the future (predicted operator ephemerides). We
    collapse them: one catalog entry per NORAD id, `l1/l2` = the segment
    whose epoch is nearest now, and — when there is more than one — the full
    epoch-sorted list under `segs` so the frontend can propagate each moment
    with the nearest segment.
    """
    groups, order = {}, []
    for rec in records:
        try:
            norad = int(rec["NORAD_CAT_ID"])
        except (KeyError, TypeError, ValueError):
            continue
        if norad not in groups:
            groups[norad] = []
            order.append(norad)
        groups[norad].append(rec)
    out, now = [], time.time()
    for norad in order:
        segs, name = [], ""
        for rec in sorted(groups[norad], key=lambda r: str(r.get("EPOCH") or "")):
            try:
                l1, l2 = omm_to_tle(rec)
            except Exception:
                continue
            segs.append({"epoch": str(rec.get("EPOCH") or ""), "l1": l1, "l2": l2})
            if not name:
                name = SUPGP_SEG_RE.sub("", str(rec.get("OBJECT_NAME") or "")).strip()
        if not segs:
            continue
        best = min(range(len(segs)),
                   key=lambda i: abs(_iso_unix(segs[i]["epoch"]) - now))
        ent = {"name": name or f"OBJECT {norad}",
               "l1": segs[best]["l1"], "l2": segs[best]["l2"], "norad": norad}
        if len(segs) > 1:
            ent["segs"] = segs
        out.append(ent)
    return out


def parse_supgp_index(html):
    """Scrape the supplemental index page for available FILE names.

    The stable operator files (iss, css, starlink, …) sit in the main table
    with a plain-text label; launch-specific files (starlink-g17-39,
    …-g17-39b1, …) appear and expire with each launch, labeled 'X Pre-Launch'
    or 'Backup Launch Opportunity #N'. Label = last text line preceding the
    link in its table cell; launch-specific = name contains a digit.
    """
    files, seen = [], set()
    for m in re.finditer(r'href="sup-gp\.php\?FILE=([A-Za-z0-9.-]+)&', html):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        cell = html.rfind("<td", 0, m.start())
        chunk = html[cell:m.start()] if cell != -1 else html[max(0, m.start() - 300):m.start()]
        chunk = re.sub(r"<[^>]*$", "", chunk)   # drop the link's own unterminated <a …
        txt = re.sub(r"<(?:hr|br)[^>]*>", "\n", chunk)
        txt = re.sub(r"<[^>]*>", " ", txt)
        lines = [re.sub(r"\s+", " ", ln).strip() for ln in txt.split("\n")]
        lines = [ln for ln in lines if ln]
        label = (lines[-1] if lines else name)[:80]
        files.append({"file": name, "label": label,
                      "launch": bool(re.search(r"\d", name))})
    return files


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def make_payload(source, tles):
    # fetchedUnix is an internal extra used for cache freshness checks.
    return {
        "ok": True,
        "source": source,
        "fetched": iso_now(),
        "fetchedUnix": time.time(),
        "count": len(tles),
        "tles": tles,
    }


# ---------------------------------------------------------------------------
# Outbound HTTP + disk cache + config helpers
# ---------------------------------------------------------------------------

MAX_DOWNLOAD = 32 * 1024 * 1024      # cap on any outbound fetch body
MAX_UNZIPPED = 128 * 1024 * 1024     # cap on total decompressed zip content


def http_get(url, opener=None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    op = opener.open if opener else urllib.request.urlopen
    with op(req, timeout=FETCH_TIMEOUT) as resp:
        chunks, total = [], 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > MAX_DOWNLOAD:
                raise ApiError(502, f"Download exceeds {MAX_DOWNLOAD >> 20} MB limit")
            chunks.append(chunk)


def atomic_write(path, data_bytes, mode=None):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with _IO_LOCK:
        # create the tmp file with its final permissions from the start
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                     mode if mode is not None else 0o644)
        try:
            os.write(fd, data_bytes)
        finally:
            os.close(fd)
        os.replace(tmp, path)


def cache_path(key):
    return CACHE_DIR / (key + ".json")


def cache_write(key, payload):
    atomic_write(cache_path(key), json.dumps(payload).encode("utf-8"))


def cache_read(key):
    p = cache_path(key)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def load_config():
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(identity, password):
    data = json.dumps({"identity": identity, "password": password}).encode("utf-8")
    atomic_write(CONFIG_PATH, data, mode=0o600)


def spacetrack_fetch(identity, password, query_url):
    """Login to Space-Track with a cookie jar, then GET query_url -> 3le text."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    form = urllib.parse.urlencode({"identity": identity, "password": password})
    req = urllib.request.Request(
        SPACETRACK_LOGIN,
        data=form.encode("ascii"),
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with opener.open(req, timeout=FETCH_TIMEOUT) as resp:
            login_body = resp.read()
    except urllib.error.HTTPError as e:
        raise ApiError(401 if e.code in (401, 403) else 502,
                       f"Space-Track login failed (HTTP {e.code})")
    except (urllib.error.URLError, OSError) as e:
        raise ApiError(502, f"Space-Track login failed: {e}")
    # A failed login can also come back 200 with a JSON error body.
    if b'"Login"' in login_body and b"Failed" in login_body:
        raise ApiError(401, "Space-Track login failed: bad identity/password")

    qreq = urllib.request.Request(query_url, headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(qreq, timeout=FETCH_TIMEOUT) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise ApiError(502, f"Space-Track query failed (HTTP {e.code})")
    except (urllib.error.URLError, OSError) as e:
        raise ApiError(502, f"Space-Track query failed: {e}")


def spacetrack_query_url(qtype, value):
    # format/json: full-integer NORAD_CAT_ID (6+ digits) plus embedded TLE lines
    if qtype == "norad":
        parts = [s for s in re.split(r"[\s,]+", value.strip()) if s]
        try:
            ids = [str(int(s)) for s in parts]
        except ValueError:
            raise ApiError(400, "Invalid NORAD ID list (integers only)")
        if not ids:
            raise ApiError(400, "Empty NORAD ID list")
        return (f"{SPACETRACK_BASE}/basicspacedata/query/class/gp/"
                f"NORAD_CAT_ID/{','.join(ids)}/orderby/NORAD_CAT_ID/format/json")
    if qtype == "intldes":
        v = value.strip().upper()
        # accept legacy TLE form (98067A / 26162) and convert to full COSPAR
        m = re.match(r"^(\d{2})(\d{3})([A-Z]*)$", v)
        if m:
            yy = int(m.group(1))
            v = f"{1900 + yy if yy >= 57 else 2000 + yy}-{m.group(2)}{m.group(3)}"
        if not v:
            raise ApiError(400, "Empty INTLDES query")
        quoted = urllib.parse.quote(v, safe="-")
        return (f"{SPACETRACK_BASE}/basicspacedata/query/class/gp/"
                f"OBJECT_ID/~~{quoted}/orderby/OBJECT_ID/format/json")
    if qtype == "name":
        if not value.strip():
            raise ApiError(400, "Empty name query")
        quoted = urllib.parse.quote(value.strip(), safe="")
        return (f"{SPACETRACK_BASE}/basicspacedata/query/class/gp/"
                f"OBJECT_NAME/~~{quoted}/orderby/OBJECT_NAME/format/json")
    if qtype == "latest_all":
        return (f"{SPACETRACK_BASE}/basicspacedata/query/class/gp/"
                f"decay_date/null-val/epoch/%3Enow-30/orderby/norad_cat_id/format/json")
    raise ApiError(400, f"Unknown query type: {qtype!r}")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "SatObserverMX/" + VERSION
    protocol_version = "HTTP/1.1"

    # -- logging: one line per request --------------------------------------
    def log_message(self, fmt, *args):  # silence default logging
        pass

    def log_request(self, code="-", size="-"):
        code = code.value if hasattr(code, "value") else code
        print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.command:6s} "
              f"{self.path} -> {code}", flush=True)

    # -- entry points --------------------------------------------------------
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def do_HEAD(self):
        self._route("GET", head=True)

    def _route(self, method, head=False):
        # NOTE: one handler instance serves many requests on a keep-alive
        # connection — per-request state must be reset here, not just set once.
        self._head_only = head
        self._body_cache = None
        try:
            # Always drain the request body up front: an error response sent
            # with unread body bytes would poison the keep-alive connection
            # (the leftover bytes get parsed as the next request line).
            self._read_body()
            parts = urllib.parse.urlsplit(self.path)
            path = parts.path
            qs = dict(urllib.parse.parse_qsl(parts.query))
            if path.startswith("/api/"):
                self._api(method, path, qs)
            elif method == "GET":
                self._static(path)
            else:
                self._respond(405, {"ok": False, "error": "Method not allowed"})
        except ApiError as e:
            self._try_respond(e.code, {"ok": False, "error": e.msg})
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away mid-response
        except Exception as e:  # contract: 500 with the exception message
            self._try_respond(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def _try_respond(self, code, obj):
        try:
            self._respond(code, obj)
        except (BrokenPipeError, ConnectionResetError, ValueError):
            pass

    # -- API dispatch ---------------------------------------------------------
    def _api(self, method, path, qs):
        if method == "GET":
            if path == "/api/ping":
                return self._respond(200, {"ok": True, "version": VERSION})
            if path == "/api/celestrak/groups":
                groups = [{"id": g, "name": n} for g, n in CELESTRAK_GROUPS]
                return self._respond(200, {"ok": True, "groups": groups})
            if path == "/api/celestrak/tle":
                return self._celestrak_tle(qs)
            if path == "/api/supgp/index":
                return self._supgp_index(qs)
            if path == "/api/supgp/tle":
                return self._supgp_tle(qs)
            if path == "/api/spacetrack/config":
                cfg = load_config()
                return self._respond(200, {
                    "ok": True,
                    "identity": cfg.get("identity") or None,
                    "hasPassword": bool(cfg.get("password")),
                })
            if path == "/api/satcat":
                return self._satcat(qs)
            if path == "/api/cache":
                return self._cache_list()
            if path.startswith("/api/cache/"):
                return self._cache_get(path[len("/api/cache/"):])
            if path == "/api/state":
                return self._state_get()
        elif method == "POST":
            if path == "/api/spacetrack/tle":
                return self._spacetrack_tle()
            if path == "/api/mccants/tle":
                return self._mccants_tle()
            if path == "/api/text/tle":
                return self._text_tle()
            if path == "/api/refresh/tle":
                return self._refresh_tle()
            if path == "/api/state":  # unload-flush friendly alias for PUT
                return self._state_put()
        elif method == "PUT":
            if path == "/api/state":
                return self._state_put()
        elif method == "DELETE":
            if path.startswith("/api/cache/"):
                return self._cache_delete(path[len("/api/cache/"):])
        raise ApiError(404, f"No such API endpoint: {method} {path}")

    # -- request body ----------------------------------------------------------
    def _read_body(self):
        if getattr(self, "_body_cache", None) is None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            self._body_cache = self.rfile.read(length) if length > 0 else b""
        return self._body_cache

    def _read_json(self):
        raw = self._read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError(400, "Invalid JSON body")

    def _read_json_dict(self):
        obj = self._read_json()
        if not isinstance(obj, dict):
            raise ApiError(400, "JSON body must be an object")
        return obj

    # -- API handlers ------------------------------------------------------------
    def _celestrak_tle(self, qs):
        group = qs.get("group", "")
        if not GROUP_ID_RE.fullmatch(group):
            raise ApiError(400, "Missing or invalid 'group' parameter")
        key = f"celestrak_{group}"
        refresh = qs.get("refresh") == "1"
        cached = cache_read(key)
        if (cached and not refresh
                and time.time() - cached.get("fetchedUnix", 0) < CACHE_FRESH_S):
            return self._respond(200, cached)
        url = CELESTRAK_URL.format(group=urllib.parse.quote(group, safe=""))
        try:
            raw = http_get(url)
        except Exception as e:
            if cached:  # network failure -> serve stale copy
                return self._respond(200, {**cached, "stale": True})
            raise ApiError(502, f"CelesTrak fetch failed: {e}")
        text = raw.decode("utf-8", "replace")
        try:
            records = json.loads(text)
        except ValueError:
            raise ApiError(502, f"CelesTrak returned no data for group "
                                f"{group!r}: {text[:120].strip()}")
        tles = omm_records_to_tles(records if isinstance(records, list) else [])
        if not tles:
            raise ApiError(502, f"CelesTrak returned no elements for group {group!r}")
        payload = make_payload(f"celestrak:{group}", tles)
        cache_write(key, payload)
        self._respond(200, payload)

    def _supgp_index(self, qs):
        """List of currently available SupGP FILE names, scraped from the
        supplemental index page (stable operator files + transient
        launch-specific files). Cached like TLE fetches, stale fallback."""
        key = "supgp_index"
        refresh = qs.get("refresh") == "1"
        cached = cache_read(key)
        if (cached and not refresh
                and time.time() - cached.get("fetchedUnix", 0) < CACHE_FRESH_S):
            return self._respond(200, cached)
        try:
            html = http_get(SUPGP_INDEX_URL).decode("utf-8", "replace")
        except Exception as e:
            if cached:
                return self._respond(200, {**cached, "stale": True})
            raise ApiError(502, f"SupGP index fetch failed: {e}")
        files = parse_supgp_index(html)
        if not files:
            raise ApiError(502, "SupGP index page yielded no FILE entries")
        payload = {"ok": True, "fetched": iso_now(), "fetchedUnix": time.time(),
                   "files": files}
        cache_write(key, payload)
        self._respond(200, payload)

    def _supgp_tle(self, qs):
        fname = (qs.get("file") or "").strip().lower()
        if not SUPGP_FILE_RE.fullmatch(fname):
            raise ApiError(400, "Missing or invalid 'file' parameter")
        key = f"supgp_{fname}"
        refresh = qs.get("refresh") == "1"
        cached = cache_read(key)
        if (cached and not refresh
                and time.time() - cached.get("fetchedUnix", 0) < CACHE_FRESH_S):
            return self._respond(200, cached)
        url = SUPGP_URL.format(file=urllib.parse.quote(fname, safe=""))
        try:
            raw = http_get(url)
        except Exception as e:
            if cached:
                return self._respond(200, {**cached, "stale": True})
            raise ApiError(502, f"CelesTrak SupGP fetch failed: {e}")
        text = raw.decode("utf-8", "replace")
        try:
            records = json.loads(text)
        except ValueError:
            raise ApiError(502, f"No SupGP data for file {fname!r} "
                                f"(retired launch file?): {text[:120].strip()}")
        tles = supgp_records_to_tles(records if isinstance(records, list) else [])
        if not tles:
            raise ApiError(502, f"SupGP file {fname!r} contained no elements")
        payload = make_payload(f"supgp:{fname}", tles)
        cache_write(key, payload)
        self._respond(200, payload)

    def _spacetrack_tle(self):
        body = self._read_json_dict()
        query = body.get("query") or {}
        if not isinstance(query, dict):
            raise ApiError(400, "'query' must be an object")
        qtype = query.get("type")
        value = str(query.get("value") or "")
        cfg = load_config()
        identity = (body.get("identity") or "").strip() or (cfg.get("identity") or "")
        password = body.get("password") or cfg.get("password") or ""
        if not identity or not password:
            raise ApiError(400, "Space-Track credentials required "
                                "(none provided and none saved)")
        url = spacetrack_query_url(qtype, value)
        text = spacetrack_fetch(identity, password, url)
        if body.get("save"):  # login succeeded: credentials proven, save now
            save_config(identity, password)
        try:
            records = json.loads(text)
        except ValueError:
            raise ApiError(502, "Space-Track returned unparseable data: " +
                                text[:120].strip())
        tles = omm_records_to_tles(records if isinstance(records, list) else [])
        if not tles:
            raise ApiError(502, "Space-Track returned no elements for this query")
        payload = make_payload(f"spacetrack:{qtype}", tles)
        key = "spacetrack_" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
        cache_write(key, payload)
        self._respond(200, payload)

    def _mccants_tle(self):
        body = self._read_json_dict()
        url = (body.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ApiError(400, "Missing or invalid 'url' (must be http/https)")
        try:
            raw = http_get(url)
        except Exception as e:
            raise ApiError(502, f"Download failed: {e}")
        if raw[:2] == b"PK":  # zip archive: concatenate all .tle/.txt members
            try:
                zf = zipfile.ZipFile(io.BytesIO(raw))
                texts, total = [], 0
                for info in zf.infolist():
                    if not info.filename.lower().endswith((".tle", ".txt")):
                        continue
                    total += info.file_size
                    if total > MAX_UNZIPPED:
                        raise ApiError(502, "Zip contents exceed the size limit")
                    texts.append(zf.read(info).decode("utf-8", "replace"))
            except zipfile.BadZipFile:
                raise ApiError(502, "Downloaded file is not a valid zip archive")
            if not texts:
                raise ApiError(502, "Zip archive contains no .tle/.txt members")
            text = "\n".join(texts)
        else:
            text = raw.decode("utf-8", "replace")
        tles = parse_tles(text)
        if not tles:
            raise ApiError(502, f"No TLEs found at {url}")
        basename = pathlib.PurePosixPath(urllib.parse.urlsplit(url).path).name or "download"
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", basename)
        payload = make_payload(f"mccants:{safe}", tles)
        cache_write(f"mccants_{safe}", payload)
        self._respond(200, payload)

    def _text_tle(self):
        body = self._read_json_dict()
        text = body.get("text") or ""
        if not isinstance(text, str) or not text.strip():
            raise ApiError(400, "Missing 'text'")
        tles = parse_tles(text)
        if not tles:
            raise ApiError(400, "No valid TLEs found in pasted text")
        label = body.get("label")
        source = f"text:{label}" if label else "text"
        payload = make_payload(source, tles)
        self._respond(200, payload)  # no cache for pasted text

    # -- per-family TLE refresh -------------------------------------------------
    def _refresh_tle(self):
        """Fetch the freshest TLE for a list of NORAD ids.

        Order: (1) satellites imported from a SupGP file re-fetch that same
        file (operator ephemerides beat standard GP, and launch objects may
        exist nowhere else yet); a retired/renamed file just drops through.
        (2) Space-Track batch query when credentials are saved. (3) CelesTrak
        per-object fallback for whatever is still missing."""
        body = self._read_json_dict()
        sats_in = body.get("sats")
        src_by_id = {}
        if isinstance(sats_in, list) and sats_in:
            raw_ids = []
            for s in sats_in:
                if not isinstance(s, dict):
                    continue
                try:
                    n = int(s.get("norad"))
                except (TypeError, ValueError):
                    continue
                raw_ids.append(n)
                src = str(s.get("source") or "")
                if src.startswith("supgp:"):
                    src_by_id[n] = src[len("supgp:"):]
        else:
            raw_ids = body.get("norads")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ApiError(400, "Missing 'sats' or 'norads' list")
        try:
            ids = sorted({int(n) for n in raw_ids})
        except (TypeError, ValueError):
            raise ApiError(400, "'norads' must be integers")
        if len(ids) > 500:
            raise ApiError(400, "Too many objects in one refresh (max 500)")

        results, notes = {}, []

        supgp_files = {}
        for n, f in src_by_id.items():
            if SUPGP_FILE_RE.fullmatch(f):
                supgp_files.setdefault(f, set()).add(n)
        for f in sorted(supgp_files)[:10]:   # a family rarely spans many files
            want = supgp_files[f]
            try:
                raw = http_get(SUPGP_URL.format(file=urllib.parse.quote(f, safe="")))
                tles = supgp_records_to_tles(json.loads(raw.decode("utf-8", "replace")))
            except Exception:
                notes.append(f"SupGP {f} unavailable — using standard sources")
                continue
            got = 0
            for t in tles:
                if t["norad"] in want:
                    results[t["norad"]] = {**t, "src": f"supgp:{f}"}
                    got += 1
            if got:
                notes.append(f"SupGP {f}: {got}")
            cache_write(f"supgp_{f}", make_payload(f"supgp:{f}", tles))

        pending = [i for i in ids if i not in results]
        cfg = load_config()
        if pending and cfg.get("identity") and cfg.get("password"):
            try:
                url = spacetrack_query_url("norad", ",".join(map(str, pending)))
                text = spacetrack_fetch(cfg["identity"], cfg["password"], url)
                got = 0
                for t in omm_records_to_tles(json.loads(text)):
                    if t["norad"] not in results:
                        results[t["norad"]] = t
                        got += 1
                notes.append(f"Space-Track: {got}")
            except ApiError as e:
                notes.append(f"Space-Track failed: {e.msg}")
            except Exception as e:
                notes.append(f"Space-Track failed: {e}")

        missing = [i for i in ids if i not in results]
        if missing:
            if len(missing) > 60:
                notes.append(f"{len(missing)} not on Space-Track; too many for "
                             "per-object CelesTrak fallback (max 60)")
            else:
                got = 0
                for i in missing:
                    try:
                        raw = http_get(CELESTRAK_CATNR_URL.format(norad=i))
                        for t in omm_records_to_tles(json.loads(raw.decode("utf-8", "replace"))):
                            if t["norad"] == i:
                                results[i] = t
                                got += 1
                    except Exception:
                        pass  # stays missing
                if got:
                    notes.append(f"CelesTrak: {got}")

        still_missing = [i for i in ids if i not in results]
        if not results:
            raise ApiError(502, "No TLEs could be refreshed" +
                                (" — " + "; ".join(notes) if notes else ""))
        self._respond(200, {
            "ok": True, "fetched": iso_now(), "count": len(results),
            "tles": [results[i] for i in ids if i in results],
            "missing": still_missing, "notes": notes,
        })

    # -- SATCAT (launch date/site etc. from CelesTrak) --------------------------
    def _satcat(self, qs):
        try:
            norad = int(qs.get("norad", ""))
        except ValueError:
            raise ApiError(400, "Missing or invalid 'norad' parameter")
        cache_file = CACHE_DIR / "satcat_map.json"
        try:
            table = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            table = {}
        ent = table.get(str(norad))
        if ent and time.time() - ent.get("fetched", 0) < SATCAT_FRESH_S:
            return self._respond(200, {"ok": True, "record": ent.get("record")})
        try:
            raw = http_get(SATCAT_URL.format(norad=norad))
            arr = json.loads(raw.decode("utf-8", "replace"))
            record = arr[0] if isinstance(arr, list) and arr else None
        except Exception as e:
            if ent:  # network failure -> serve the stale record
                return self._respond(200, {"ok": True, "record": ent.get("record"),
                                           "stale": True})
            raise ApiError(502, f"SATCAT fetch failed: {e}")
        table[str(norad)] = {"record": record, "fetched": time.time()}
        atomic_write(cache_file, json.dumps(table).encode("utf-8"))
        self._respond(200, {"ok": True, "record": record})

    # -- cache endpoints ----------------------------------------------------------
    @staticmethod
    def _check_cache_key(key):
        if not CACHE_KEY_RE.fullmatch(key or ""):
            raise ApiError(400, "Invalid cache key")
        return key

    def _cache_list(self):
        entries = []
        try:
            files = sorted(CACHE_DIR.glob("*.json"))
        except OSError:
            files = []
        for p in files:
            try:
                payload = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue  # skip corrupt entries
            if not isinstance(payload, dict) or "tles" not in payload:
                continue  # not a TLE set (e.g. satcat_map.json)
            entries.append({
                "key": p.stem,
                "source": payload.get("source"),
                "fetched": payload.get("fetched"),
                "count": payload.get("count"),
            })
        self._respond(200, {"ok": True, "entries": entries})

    def _cache_get(self, key):
        payload = cache_read(self._check_cache_key(key))
        if payload is None:
            raise ApiError(404, f"No cache entry: {key}")
        self._respond(200, payload)

    def _cache_delete(self, key):
        p = cache_path(self._check_cache_key(key))
        if not p.is_file():
            raise ApiError(404, f"No cache entry: {key}")
        with _IO_LOCK:
            p.unlink(missing_ok=True)
        self._respond(200, {"ok": True, "deleted": key})

    # -- state endpoints -------------------------------------------------------
    def _state_get(self):
        try:
            obj = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            obj = {}
        self._respond(200, obj)

    def _state_put(self):
        raw = self._read_body()
        try:
            obj = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            raise ApiError(400, "Invalid JSON body")
        atomic_write(STATE_PATH, json.dumps(obj).encode("utf-8"))
        self._respond(200, {"ok": True})

    # -- responses ----------------------------------------------------------------
    def _respond(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)

    # -- static files ---------------------------------------------------------------
    def _static(self, path):
        rel = urllib.parse.unquote(path)
        if "\x00" in rel:
            raise ApiError(400, "Bad path")
        if rel in ("", "/"):
            rel = "/index.html"
        target = (APP_DIR / rel.lstrip("/")).resolve()
        # traversal protection: resolved path must live under the app root
        if not target.is_relative_to(APP_DIR) or not target.is_file():
            raise ApiError(404, f"Not found: {path}")
        ext = target.suffix.lower()
        mtime = target.stat().st_mtime  # stat before send_response: no half-sent 500
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",
                         MIME_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        if ext in (".html", ".js", ".css"):
            self.send_header("Cache-Control", "no-cache")
        elif ext == ".jpg":
            self.send_header("Cache-Control", "max-age=86400")
        self.send_header("Last-Modified", formatdate(mtime, usegmt=True))
        self.end_headers()
        if not getattr(self, "_head_only", False):
            self.wfile.write(data)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def make_server(start_port):
    last_err = None
    for port in range(start_port, start_port + PORT_TRIES):
        try:
            return http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        except OSError as e:
            last_err = e
    raise SystemExit(f"Could not bind any port in "
                     f"{start_port}..{start_port + PORT_TRIES - 1}: {last_err}")


def start_in_thread(start_port=DEFAULT_PORT):
    """Start the server on a background thread (for the desktop shell).
    Returns the port actually bound."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    httpd = make_server(start_port)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd.server_address[1]


def main():
    ap = argparse.ArgumentParser(description="SatObserver-MX backend")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"port to listen on (default {DEFAULT_PORT}; "
                         f"tries the next {PORT_TRIES - 1} if busy)")
    ap.add_argument("--no-browser", action="store_true",
                    help="do not open a web browser on startup")
    args = ap.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    httpd = make_server(args.port)
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    print(f"SatObserver-MX  {url}", flush=True)
    if not args.no_browser:
        t = threading.Timer(0.4, webbrowser.open, [url])
        t.daemon = True
        t.start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
