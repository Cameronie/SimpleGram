#!/usr/bin/env python3
"""A current Android System WebView on the test emulator.

The sg29 emulator image (Android 10) ships WebView 74, which has no Popover
API, so R10's page-mode full screen never runs there. Chromium publishes
per-commit Android builds, and the x86_64 one carries a SystemWebView.apk that
installs on Android 10+ (minSdk 29). This script fetches just that APK out of
the 500 MB build zip (range requests: the zip's directory, then the one entry)
and mounts it over the emulator's own WebView for the life of the emulator.

  tools/emu-webview.py list                 what the latest build zip holds
  tools/emu-webview.py fetch [DIR]          save SystemWebView.apk into DIR
  tools/emu-webview.py mount [APK]          bind-mount it on the running emulator
                                            and restart Android's framework

Needs: a booted emulator reachable by adb (started without -writable-system;
see notes/batch-6/b28-diagnosis.md for why), network access to
commondatastorage.googleapis.com. No Instagram host is contacted.
"""
import os
import struct
import subprocess
import sys
import time
import urllib.request
import zlib

BUCKET = 'https://commondatastorage.googleapis.com/chromium-browser-snapshots'
PLATFORM = os.environ.get('WEBVIEW_PLATFORM', 'AndroidDesktop_x64')
ENTRY = 'SystemWebView.apk'
DEFAULT_DIR = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'simplegram-webview')


def get(url, rng=None):
    req = urllib.request.Request(url)
    if rng:
        req.add_header('Range', 'bytes=%d-%d' % rng)
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def latest():
    rev = get('%s/%s/LAST_CHANGE' % (BUCKET, PLATFORM)).decode().strip()
    return rev, '%s/%s/%s/chrome-android-desktop.zip' % (BUCKET, PLATFORM, rev)


def head_size(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=120) as r:
        return int(r.headers['Content-Length'])


def entries(url):
    """The zip's central directory: (name, method, compressed, size, offset)."""
    size = head_size(url)
    tail = get(url, (size - 65536, size - 1))
    i = tail.rfind(b'PK\x05\x06')
    if i < 0:
        raise SystemExit('no end-of-directory record in the zip')
    cd_size, cd_off = struct.unpack('<II', tail[i + 12:i + 20])
    cd = get(url, (cd_off, cd_off + cd_size - 1))
    out, p = [], 0
    while True:
        j = cd.find(b'PK\x01\x02', p)
        if j < 0:
            break
        method = struct.unpack('<H', cd[j + 10:j + 12])[0]
        csize, usize = struct.unpack('<II', cd[j + 20:j + 28])
        n, e, c = struct.unpack('<HHH', cd[j + 28:j + 34])
        off = struct.unpack('<I', cd[j + 42:j + 46])[0]
        name = cd[j + 46:j + 46 + n].decode('utf-8', 'replace')
        out.append((name, method, csize, usize, off))
        p = j + 46 + n + e + c
    return out


def cmd_list():
    rev, url = latest()
    print('build', rev)
    for name, method, csize, usize, off in entries(url):
        print('%12d  %12d  %s' % (csize, usize, name))


def cmd_fetch(out_dir):
    rev, url = latest()
    hit = [e for e in entries(url) if e[0].endswith('/' + ENTRY)]
    if not hit:
        raise SystemExit('no %s in build %s' % (ENTRY, rev))
    name, method, csize, usize, off = hit[0]
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, ENTRY)
    print('build %s: %s (%d bytes compressed)' % (rev, name, csize))
    head = get(url, (off, off + 29))
    if head[:4] != b'PK\x03\x04':
        raise SystemExit('bad local header')
    n, e = struct.unpack('<HH', head[26:30])
    start = off + 30 + n + e
    req = urllib.request.Request(url)
    req.add_header('Range', 'bytes=%d-%d' % (start, start + csize - 1))
    dec = zlib.decompressobj(-15) if method == 8 else None
    done = 0
    with urllib.request.urlopen(req, timeout=600) as r, open(path, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(dec.decompress(chunk) if dec else chunk)
            done += len(chunk)
            sys.stdout.write('\r%3d%%' % (100 * done // csize))
            sys.stdout.flush()
        if dec:
            f.write(dec.flush())
    print('\nsaved', path, os.path.getsize(path), 'bytes')
    return path


def adb(*args, check=True):
    r = subprocess.run(['adb'] + list(args), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit('adb %s failed: %s' % (' '.join(args), r.stderr.strip()))
    return r.stdout.strip()


def cmd_mount(apk):
    if not os.path.isfile(apk):
        raise SystemExit('no such APK: %s' % apk)
    sysdir = adb('shell', 'pm', 'path', 'com.android.webview').replace('package:', '')
    sysdir = os.path.dirname(sysdir) or '/system/product/app/webview'
    print('system WebView at', sysdir)
    adb('root', check=False)
    time.sleep(4)
    adb('wait-for-device')
    adb('shell', 'mkdir', '-p', '/data/local/tmp/wv')
    print('pushing', apk)
    adb('push', apk, '/data/local/tmp/wv/webview.apk')
    adb('shell', 'setenforce 0; chmod 755 /data/local/tmp/wv; chmod 644 /data/local/tmp/wv/webview.apk; '
        'chcon -R u:object_r:system_file:s0 /data/local/tmp/wv; '
        'mount -o bind /data/local/tmp/wv ' + sysdir)
    print('restarting the framework (about a minute)')
    adb('shell', 'stop; sleep 2; start')
    for _ in range(90):
        time.sleep(5)
        out = adb('shell', 'dumpsys', 'webviewupdate', check=False)
        line = next((l for l in out.splitlines() if 'Current WebView package' in l), '')
        if line and '74.0' not in line:
            print(line.strip())
            return
    raise SystemExit('the framework did not pick up the new WebView; is the emulator booted?')


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if what == 'list':
        cmd_list()
    elif what == 'fetch':
        cmd_fetch(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DIR)
    elif what == 'mount':
        cmd_mount(sys.argv[2] if len(sys.argv) > 2 else os.path.join(DEFAULT_DIR, ENTRY))
    else:
        raise SystemExit(__doc__)
