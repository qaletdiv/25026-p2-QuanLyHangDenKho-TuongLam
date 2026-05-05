import ContactsClient from './ContactsClient';
import { getContacts } from '@/app/actions/contacts';

export default async function ContactsPage() {
  let contacts = [];
  try {
    contacts = await getContacts() || [];
  } catch (e) {
    console.error('Failed to fetch contacts:', e);
  }

  return <ContactsClient initialContacts={contacts || []} />;
}
