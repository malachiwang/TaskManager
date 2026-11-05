"""tm-clean 25: custom banner image stored next to the database."""
import io
import struct
import zlib

import backend.database as db

PNG = (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
       + struct.pack(">I", zlib.crc32(b"IHDR" + struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))))
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 32


def up(client, data, name="x.bin", ctype="application/octet-stream"):
    return client.post("/banner-image", files={"file": (name, io.BytesIO(data), ctype)})


def test_upload_get_replace_delete(client):
    r = up(client, PNG, "photo.png", "image/png")
    assert r.status_code == 201
    name = r.json()["filename"]
    assert name.startswith("banner-") and name.endswith(".png")
    assert (db.DB_PATH.parent / name).is_file()
    g = client.get(f"/banner-image/{name}")
    assert g.status_code == 200 and g.headers["content-type"] == "image/png" and g.content == PNG
    # Replacing keeps exactly one stored banner.
    name2 = up(client, WEBP, "p.webp").json()["filename"]
    assert name2.endswith(".webp")
    assert sorted(p.name for p in db.DB_PATH.parent.glob("banner-*")) == [name2]
    assert client.get(f"/banner-image/{name}").status_code == 404
    assert client.delete("/banner-image").json() == {"deleted": True}
    assert not list(db.DB_PATH.parent.glob("banner-*"))


def test_jpeg_detected_by_content_not_name(client):
    assert up(client, JPG, "misnamed.png").json()["filename"].endswith(".jpg")


def test_rejects_other_types_and_oversize(client):
    assert up(client, b"GIF89a" + b"\x00" * 20, "a.gif", "image/gif").status_code == 415
    assert up(client, b"%PDF-1.4", "a.png", "image/png").status_code == 415
    big = PNG + b"\x00" * (10 * 1024 * 1024)
    assert up(client, big, "big.png", "image/png").status_code == 413
    assert not list(db.DB_PATH.parent.glob("banner-*"))


def test_get_rejects_other_paths(client):
    for bad in ["taskos.db", "..%2Ftaskos.db", "banner-1.gif", "banner-abc.png"]:
        assert client.get(f"/banner-image/{bad}").status_code == 404


def test_backup_does_not_include_the_image(client):
    up(client, PNG, "photo.png", "image/png")
    backup = client.get("/export/backup.json").text
    assert "banner-" not in backup
