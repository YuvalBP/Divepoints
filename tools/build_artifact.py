"""Bundle the app into one self-contained page for publishing as a
claude.ai artifact: dist/divepoints.html.

Artifacts only load scripts from a few CDNs (Leaflet from unpkg is
fine) and no external stylesheets or images, so Leaflet's CSS and its
control icons are inlined, and so are the app's own CSS and JS.

Usage: python3 tools/build_artifact.py
Needs network access to unpkg.com for Leaflet's CSS and images.
"""
import base64, pathlib, re, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/"


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def leaflet_css():
    css = fetch(LEAFLET + "leaflet.css").decode()

    def inline(m):
        name = m.group(1)
        data = base64.b64encode(fetch(LEAFLET + "images/" + name)).decode()
        return f'url("data:image/png;base64,{data}")'
    return re.sub(r'url\(images/([\w.-]+\.png)\)', inline, css)


def main():
    html = (ROOT / "index.html").read_text()
    title = re.search(r"<title>.*?</title>", html).group(0)
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)

    def inline_script(m):
        src = m.group(1)
        if src.startswith("http"):
            return m.group(0)
        code = (ROOT / src).read_text().replace("</script", "<\\/script")
        return f"<script>\n{code}\n</script>"
    body = re.sub(r'<script src="([^"]+)"></script>', inline_script, body)

    css = leaflet_css() + "\n" + (ROOT / "css/style.css").read_text()
    page = f"{title}\n<style>\n{css}\n</style>\n{body.strip()}\n"
    out = ROOT / "dist/divepoints.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(page)
    print(f"wrote {out} ({len(page) // 1024} KB)")


if __name__ == "__main__":
    main()
