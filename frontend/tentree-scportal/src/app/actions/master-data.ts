'use server';

import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), '..', '..', 'backend', 'data');

async function readJson(filename: string) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading ${filename}:`, error);
    return [];
  }
}

async function writeJson(filename: string, data: any) {
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function getSuppliers() { return readJson('suppliers.json'); }
export async function getCouriers() { return readJson('couriers.json'); }
export async function getIncoterms() { return readJson('incoterms.json'); }
export async function getStatuses() { return readJson('statuses.json'); }

export async function updateSuppliers(data: any) { await writeJson('suppliers.json', data); return { success: true }; }
export async function updateCouriers(data: any) { await writeJson('couriers.json', data); return { success: true }; }
export async function updateIncoterms(data: any) { await writeJson('incoterms.json', data); return { success: true }; }
export async function updateStatuses(data: any) { await writeJson('statuses.json', data); return { success: true }; }
