import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AdminSubnav } from '@/components/admin/admin-subnav';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  return (
    <div className="w-full px-6 py-8 lg:px-8">
      <AdminSubnav />
      {children}
    </div>
  );
}
