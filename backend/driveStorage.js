const { google } = require('googleapis');
const stream = require('stream');
const fs = require('fs');
const path = require('path');

class GoogleDriveStorage {
    constructor() {
        this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        this.fileMap = new Map();
        this.drive = null;
        this.localDataDir = path.join(__dirname, 'data');
    }

    async init() {
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
        if (!this.drive) {
            // Fallback
            fs.writeFileSync(path.join(this.localDataDir, filename), JSON.stringify(data, null, 2));
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
                    media
                });
                this.fileMap.set(filename, res.data.id);
            }
        } catch (e) {
            console.error(`Error writing ${filename} to Drive:`, e.message);
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
