const driveStorage = require('../driveStorage');

class BaseModel {
    constructor(filename) {
        this.filename = filename;
    }

    async read() {
        return driveStorage.readData(this.filename);
    }

    async write(data) {
        return driveStorage.writeData(this.filename, data);
    }
}

module.exports = BaseModel;
