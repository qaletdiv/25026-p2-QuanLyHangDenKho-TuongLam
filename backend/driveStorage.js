const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// DATA_BACKEND selects where the portal's records live:
//
//   postgres (default)  db/pgStore.js — real tables, real keys, one transaction
//                       per write request.
//   json                the original JSON files under backend/data/.
//
// The switch exists so a problem in Postgres is one env var away from being
// backed out of, not a git revert. Note that it is NOT a mirror: once the app
// has been writing to Postgres, the JSON files are a frozen snapshot from
// migration day, and switching back moves the portal to that snapshot.
//
// It applies to readData/writeData ONLY. uploadFile still writes real file
// blobs (CI workbooks, packing lists, ASNs) to Drive or disk — those are
// documents, not records, and nothing about them changed.
// ---------------------------------------------------------------------------
const DATA_BACKEND = (process.env.DATA_BACKEND || 'postgres').toLowerCase();

class GoogleDriveStorage {
    constructor() {
        this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        this.fileMap = new Map();
        this.drive = null;
        this.localDataDir = path.join(__dirname, 'data');
        this.backend = DATA_BACKEND;
        // Required lazily: db/pool.js opens a connection pool on require, which
        // a DATA_BACKEND=json run should not do.
        this.pg = DATA_BACKEND === 'postgres' ? require('./db/pgStore') : null;
    }

    async init() {
        if (this.pg) {
            // A failed ping must NOT stop the server coming up. Postgres here runs
            // in a container that can be down for reasons that have nothing to do
            // with the app (the WSL distro idling out takes dockerd with it), and
            // refusing to boot would turn a database blip into "the portal is
            // gone until someone restarts node". The pool reconnects by itself,
            // so the next request after Postgres returns simply works.
            try {
                const { ping } = require('./db/pool');
                const info = await ping();
                console.log(`Data backend: PostgreSQL (${info.db}).`);
            } catch (e) {
                console.error('='.repeat(72));
                console.error(`Data backend: PostgreSQL — CANNOT CONNECT (${e.code || e.message}).`);
                console.error('The server is starting anyway and will reconnect on its own, but every');
                console.error('request that touches data will fail until the database is reachable.');
                console.error(`  connection: ${require('./db/pool').connectionString().replace(/:[^:@/]*@/, ':****@')}`);
                console.error('  if it runs in WSL:  wsl -e docker start some-postgres');
                console.error('='.repeat(72));
            }
            return;
        }
        console.log('Data backend: local JSON files (DATA_BACKEND=json).');

        if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !this.folderId) {
            console.log("No Google Drive credentials found. Falling back to local fs storage.");
            return;
        }

        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                },
                scopes: ['https://www.googleapis.com/auth/drive.file'],
            });

            this.drive = google.drive({ version: 'v3', auth });
            await this.refreshFileMap();
            console.log("Successfully connected to Google Drive API.");
        } catch(e) {
            console.error("Failed to initialize Google Drive client:", e.message);
        }
    }

    async refreshFileMap() {
        if (!this.drive) return;
        try {
            const res = await this.drive.files.list({
                q: `'${this.folderId}' in parents and trashed = false`,
                fields: 'files(id, name)',
            });
            this.fileMap.clear();
            res.data.files.forEach(f => this.fileMap.set(f.name, f.id));
        } catch (e) {
            console.error("Error listing Drive files:", e.message);
        }
    }

    async readData(filename) {
        if (this.pg) return this.pg.readData(filename);

        if (!this.drive) {
            // Fallback
            try {
                const filepath = path.join(this.localDataDir, filename);
                if (!fs.existsSync(filepath)) return [];
                const raw = fs.readFileSync(filepath, 'utf8');
                return JSON.parse(raw);
            } catch (e) { return []; }
        }

        const fileId = this.fileMap.get(filename);
        if (!fileId) return [];

        try {
            const res = await this.drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
            return new Promise((resolve, reject) => {
                let data = '';
                res.data.on('data', chunk => data += chunk);
                res.data.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch(e) { resolve([]); }
                });
                res.data.on('error', reject);
            });
        } catch (e) {
            console.error(`Error reading ${filename} from Drive:`, e.message);
            return [];
        }
    }

    async writeData(filename, data) {
        if (this.pg) return this.pg.writeData(filename, data);

        if (!this.drive) {
            // Atomic local write: serialise to a temp file first, then rename over the target.
            // This prevents data loss if the process is killed or throws mid-write — the
            // original file is never partially overwritten.
            const targetPath = path.join(this.localDataDir, filename);
            const tmpPath    = targetPath + '.tmp';
            try {
                fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
                fs.renameSync(tmpPath, targetPath);
            } catch (e) {
                // Clean up the orphaned temp file if rename failed
                try { fs.unlinkSync(tmpPath); } catch (_) {}
                throw e;
            }
            return;
        }
        
        const jsonString = JSON.stringify(data, null, 2);
        const bufferStream = new stream.PassThrough();
        bufferStream.end(jsonString);
        
        const media = {
            mimeType: 'application/json',
            body: bufferStream
        };

        const fileId = this.fileMap.get(filename);

        try {
            if (fileId) {
                await this.drive.files.update({ fileId, media });
            } else {
                const res = await this.drive.files.create({
                    requestBody: { name: filename, parents: [this.folderId] },
                    media,
                });
                this.fileMap.set(filename, res.data.id);
            }
        } catch (e) {
            // Re-throw so callers know the write failed — silently swallowing Drive
            // errors could leave the app running on stale data with no indication.
            console.error(`Error writing ${filename} to Drive:`, e.message);
            throw e;
        }
    }

    async uploadFile(filename, bufferStream, mimeType) {
        if (!this.drive) {
            // Fallback to local storage
            const uploadDir = path.join(this.localDataDir, 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            const filepath = path.join(uploadDir, filename);
            
            return new Promise((resolve, reject) => {
                const writeStream = fs.createWriteStream(filepath);
                bufferStream.pipe(writeStream);
                writeStream.on('finish', () => resolve({ id: filename, url: `/uploads/${filename}` }));
                writeStream.on('error', reject);
            });
        }

        try {
            const res = await this.drive.files.create({
                requestBody: { name: filename, parents: [this.folderId] },
                media: { mimeType, body: bufferStream },
                fields: 'id, webViewLink'
            });
            
            // Make file accessible
            try {
                await this.drive.permissions.create({
                    fileId: res.data.id,
                    requestBody: { role: 'reader', type: 'anyone' }
                });
            } catch(e) { 
                console.error('Failed to set permissions:', e.message); 
            }
            
            this.fileMap.set(filename, res.data.id);
            return { id: res.data.id, url: res.data.webViewLink };
        } catch (e) {
            console.error(`Error uploading ${filename} to Drive:`, e.message);
            throw e;
        }
    }
}

module.exports = new GoogleDriveStorage();
