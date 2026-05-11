import ContactsClient from './ContactsClient';
import { getContacts } from '@/app/actions/contacts';

export default async function ContactsPage() {
  let contacts = [];
  try {
    contacts = await getContacts() || [];
  } catch {
    // render with empty state
  }

  return <ContactsClient initialContacts={contacts || []} />;
}
