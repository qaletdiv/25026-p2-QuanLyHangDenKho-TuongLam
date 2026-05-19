const RoleModel  = require('../models/RoleModel');
const UserModel  = require('../models/UserModel');

async function getAll(req, res) {
    const roles = await RoleModel.read();
    res.json(roles);
}

async function create(req, res) {
    const roles = await RoleModel.read();
    const nameTaken = roles.some(r => r.name.toLowerCase() === req.body.name.toLowerCase());
    if (nameTaken) {
        const err = new Error('Role name already exists'); err.statusCode = 409; throw err;
    }
    const newRole = {
        id: req.body.name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now(),
        protected: false,
        ...req.body,
    };
    roles.push(newRole);
    await RoleModel.write(roles);
    res.status(201).json(newRole);
}

async function update(req, res) {
    const roles = await RoleModel.read();
    const idx = roles.findIndex(r => r.id === req.params.id);
    if (idx === -1) {
        const err = new Error('Role not found'); err.statusCode = 404; throw err;
    }
    // Protected roles: cannot rename
    if (roles[idx].protected && req.body.name && req.body.name !== roles[idx].name) {
        const err = new Error(`Cannot rename protected role "${roles[idx].name}"`); err.statusCode = 400; throw err;
    }
    roles[idx] = { ...roles[idx], ...req.body, id: roles[idx].id, protected: roles[idx].protected };
    await RoleModel.write(roles);
    res.json(roles[idx]);
}

async function remove(req, res) {
    const roles = await RoleModel.read();
    const role = roles.find(r => r.id === req.params.id);
    if (!role) {
        const err = new Error('Role not found'); err.statusCode = 404; throw err;
    }
    if (role.protected) {
        const err = new Error(`Cannot delete protected role "${role.name}"`); err.statusCode = 400; throw err;
    }
    // Guard: reject if any user has this role
    const users = await UserModel.read().catch(() => []);
    const inUse = users.some(u => u.role === role.name);
    if (inUse) {
        const err = new Error(`Role "${role.name}" is assigned to one or more users. Reassign them first.`); err.statusCode = 409; throw err;
    }
    await RoleModel.write(roles.filter(r => r.id !== req.params.id));
    res.status(204).send();
}

module.exports = { getAll, create, update, remove };
