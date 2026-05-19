const UserModel = require('../models/UserModel');
const RoleModel  = require('../models/RoleModel');
const { hashPassword } = require('../utils/passwordUtils');

async function assertValidRole(roleName) {
    if (!roleName) return;
    const roles = await RoleModel.read().catch(() => []);
    const valid = roles.some(r => r.name === roleName);
    if (!valid) {
        const err = new Error(`Invalid role "${roleName}". Create it in Role Management first.`);
        err.statusCode = 400;
        throw err;
    }
}

function strip(user) {
    const { password, ...rest } = user;
    return rest;
}

async function getAll(req, res) {
    const users = await UserModel.read();
    res.json(users.map(strip));
}

async function create(req, res) {
    await assertValidRole(req.body.role);
    const users = await UserModel.read();

    const emailTaken = users.some(u => u.email.toLowerCase() === req.body.email.toLowerCase());
    if (emailTaken) {
        const err = new Error('Email already in use'); err.statusCode = 409; throw err;
    }

    const hashed = await hashPassword(req.body.password);
    const newUser = {
        id: Date.now().toString(),
        ...req.body,
        password: hashed,
        must_change_password: true,
        supplier: req.body.supplier || null,
    };
    users.push(newUser);
    await UserModel.write(users);
    res.status(201).json(strip(newUser));
}

async function update(req, res) {
    if (req.body.role) await assertValidRole(req.body.role);
    const users = await UserModel.read();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) {
        const err = new Error('User not found'); err.statusCode = 404; throw err;
    }

    // Check email uniqueness if changing email
    if (req.body.email) {
        const conflict = users.find(
            u => u.email.toLowerCase() === req.body.email.toLowerCase() && u.id !== req.params.id
        );
        if (conflict) {
            const err = new Error('Email already in use'); err.statusCode = 409; throw err;
        }
    }

    const updated = { ...users[idx], ...req.body };

    // Hash new password if provided
    if (req.body.password) {
        updated.password = await hashPassword(req.body.password);
    }

    users[idx] = updated;
    await UserModel.write(users);
    res.json(strip(users[idx]));
}

async function remove(req, res) {
    // Cannot delete yourself
    if (req.user.id === req.params.id) {
        const err = new Error('Cannot delete your own account'); err.statusCode = 400; throw err;
    }

    let users = await UserModel.read();
    const exists = users.find(u => u.id === req.params.id);
    if (!exists) {
        const err = new Error('User not found'); err.statusCode = 404; throw err;
    }

    users = users.filter(u => u.id !== req.params.id);
    await UserModel.write(users);
    res.status(204).send();
}

module.exports = { getAll, create, update, remove };
