"""Create disposable Git archives and synthetic audit DB. Never writes to the repository."""
from pathlib import Path
import subprocess,tarfile,io,sqlite3,json,sys
repo=Path(sys.argv[1]).resolve();root=Path(sys.argv[2]).resolve();evidence=Path(__file__).resolve().parent
root.mkdir(parents=True,exist_ok=False)
for label,ref,port in [('baseline','37c60e50a0295c484686ba951fa6d25d8b61c09c',15201),('current','7ad3add5b0857f42bd846beed26c58be7670e22a',15202)]:
 dest=root/label;dest.mkdir()
 data=subprocess.check_output(['git','archive',ref],cwd=repo)
 with tarfile.open(fileobj=io.BytesIO(data)) as archive:archive.extractall(dest,filter='data')
 (dest/'frontend/node_modules').symlink_to(repo/'frontend/node_modules',target_is_directory=True)
 (dest/'audit.vite.mjs').write_text(f"import base from './frontend/vite.config.js';\nexport default {{...base,root:{json.dumps(str(dest/'frontend'))},cacheDir:{json.dumps(str(root/(label+'-cache')))},server:{{host:'127.0.0.1',port:{port},strictPort:true,proxy:{{'/api':{{target:'http://127.0.0.1:18011',rewrite:path=>path.replace(/^\\/api/,'')}}}}}}}};\n")
connection=sqlite3.connect(root/'audit.db');connection.executescript((evidence/'fixture.sql').read_text());connection.close()
print(root)
