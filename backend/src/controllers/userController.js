const { models } = require('../models');
const UserModel = models.users;
const { hashPassword } = require('../utils/passwordUtils');
const { loadUserRefs, presentUser } = require('../lib/userRefs');

// users is 3NF: the row stores roleId / supplierId / courierId; names are joined
// at read (lib/userRefs). Responses still carry `role` / `supplier` / `courier`
// NAMES beside the ids, for display.

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Resolve + check the three references, and keep them consistent with the role:
// a supplier belongs only on a Vendor, a courier only on a Freight Forwarder.
// Clearing the other one means a role change can't leave a stale link that would
// silently re-scope the account if the role were changed back.
function resolveLinks(next, refs) {
  const roleName = refs.roleName.get(next.roleId);
  if (!roleName) err(`Unknown roleId "${next.roleId}". Create the role in Role Management first.`, 400);
  if (next.supplierId && !refs.supplierName.has(next.supplierId)) err(`Unknown supplierId "${next.supplierId}"`, 400);
  if (next.courierId && !refs.courierName.has(next.courierId)) err(`Unknown courierId "${next.courierId}"`, 400);
  return {
    ...next,
    supplierId: roleName === 'Vendor' ? (next.supplierId || null) : null,
    courierId: roleName === 'Freight Forwarder' ? (next.courierId || null) : null,
  };
}

async function getAll(req, res) {
  const [users, refs] = await Promise.all([UserModel.read(), loadUserRefs()]);
  res.json(users.map((u) => presentUser(u, refs)));
}

async function create(req, res) {
  const [users, refs] = await Promise.all([UserModel.read(), loadUserRefs()]);
  if (users.some((u) => u.email.toLowerCase() === req.body.email.toLowerCase())) err('Email already in use', 409);

  const newUser = resolveLinks({
    id: Date.now().toString(),
    email: req.body.email,
    name: req.body.name,
    password: await hashPassword(req.body.password),
    mustChangePassword: true,
    roleId: req.body.roleId,
    supplierId: req.body.supplierId || null,
    courierId: req.body.courierId || null,
  }, refs);
  users.push(newUser);
  await UserModel.write(users);
  res.status(201).json(presentUser(newUser, refs));
}

// Only these fields are writable here; anything else in the body is ignored, so
// a client can't set an id or a password hash directly.
const EDITABLE = ['name', 'email', 'roleId', 'supplierId', 'courierId', 'mustChangePassword'];

async function update(req, res) {
  const [users, refs] = await Promise.all([UserModel.read(), loadUserRefs()]);
  const idx = users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) err('User not found', 404);

  if (req.body.email) {
    const conflict = users.find((u) => u.email.toLowerCase() === req.body.email.toLowerCase() && u.id !== req.params.id);
    if (conflict) err('Email already in use', 409);
  }

  const next = { ...users[idx] };
  EDITABLE.forEach((k) => { if (req.body[k] !== undefined) next[k] = req.body[k]; });
  if (req.body.password) next.password = await hashPassword(req.body.password);

  users[idx] = resolveLinks(next, refs);
  await UserModel.write(users);
  res.json(presentUser(users[idx], refs));
}

async function remove(req, res) {
  // Cannot delete yourself
  if (req.user.id === req.params.id) err('Cannot delete your own account', 400);

  let users = await UserModel.read();
  if (!users.find((u) => u.id === req.params.id)) err('User not found', 404);
  users = users.filter((u) => u.id !== req.params.id);
  await UserModel.write(users);
  res.status(204).send();
}

module.exports = { getAll, create, update, remove };
