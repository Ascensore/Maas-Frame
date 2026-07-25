import { Metadata } from 'next';
import { Prisma, BillingSubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { isBunnyUploadsFeatureEnabled, isStripeBillingEnabled } from '@/lib/feature-flags';
import { getBillingStatusLabel, hasBillingAccess } from '@/lib/billing';
import { hasCollaboratorBillingBackedAccess } from '@/lib/route-access';
import { redirect } from 'next/navigation';
import {
  getCachedBunnyStorageStats,
  getCachedUserBunnyStorage,
  getCachedUserDownloadEgress,
  getCachedUserMediaStorage,
} from '@/lib/admin-stats';
import { Film, HardDrive } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { format } from 'date-fns';

function getBillingStatusVariant(
  status: BillingSubscriptionStatus
): 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' {
  switch (status) {
    case BillingSubscriptionStatus.ACTIVE:
      return 'default';
    case BillingSubscriptionStatus.TRIALING:
    case BillingSubscriptionStatus.INCOMPLETE:
      return 'secondary';
    case BillingSubscriptionStatus.PAST_DUE:
    case BillingSubscriptionStatus.UNPAID:
      return 'destructive';
    case BillingSubscriptionStatus.CANCELED:
    case BillingSubscriptionStatus.INCOMPLETE_EXPIRED:
      return 'outline';
    case BillingSubscriptionStatus.FREE:
    default:
      return 'ghost';
  }
}

function getOwnBillingAccess(
  user: {
    subscriptionStatus: BillingSubscriptionStatus;
    trialEndsAt: Date | null;
    stripeCurrentPeriodEnd: Date | null;
    stripeCancelAtPeriodEnd: boolean;
    stripeCancelAt: Date | null;
    billingAccessEndedAt: Date | null;
  },
  now: Date
): { ownAccess: boolean; endsAt: Date | null } {
  if (!hasBillingAccess(user, now)) {
    return { ownAccess: false, endsAt: null };
  }

  const isEnding =
    user.stripeCancelAtPeriodEnd || user.subscriptionStatus === BillingSubscriptionStatus.CANCELED;

  let endsAt: Date | null = null;
  if (user.subscriptionStatus === BillingSubscriptionStatus.TRIALING) {
    endsAt = user.trialEndsAt;
  } else if (isEnding) {
    endsAt = user.stripeCurrentPeriodEnd ?? user.stripeCancelAt;
  }

  return { ownAccess: true, endsAt };
}

export const metadata: Metadata = {
  title: 'Manage Users | Admin',
};

type SortBy =
  | 'user'
  | 'subscription'
  | 'joinedDate'
  | 'workspacesOwned'
  | 'invitedMembers'
  | 'projectsOwned'
  | 'totalComments'
  | 'bunnyUpload'
  | 'downloadEgress'
  | 'mediaStorage';

type SortDirection = 'asc' | 'desc';

const SORTABLE_COLUMNS: SortBy[] = [
  'user',
  'subscription',
  'joinedDate',
  'workspacesOwned',
  'invitedMembers',
  'projectsOwned',
  'totalComments',
  'bunnyUpload',
  'downloadEgress',
  'mediaStorage',
];

function formatBytes(bytes: number, decimals = 2) {
  if (bytes < 0) return 'Error Fetching';
  if (!+bytes) return '0 Bytes';
  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function isSortBy(value: string | undefined): value is SortBy {
  return !!value && SORTABLE_COLUMNS.includes(value as SortBy);
}

function getDefaultSortDirection(sortBy: SortBy): SortDirection {
  return sortBy === 'user' ? 'asc' : 'desc';
}

function getSortIndicator(
  column: SortBy,
  activeSortBy: SortBy,
  activeSortDirection: SortDirection
): string {
  if (column !== activeSortBy) return '↕';
  return activeSortDirection === 'asc' ? '↑' : '↓';
}

function canSortInDb(sortBy: SortBy): boolean {
  return (
    sortBy === 'user' ||
    sortBy === 'subscription' ||
    sortBy === 'joinedDate' ||
    sortBy === 'workspacesOwned' ||
    sortBy === 'projectsOwned' ||
    sortBy === 'totalComments'
  );
}

function getUsersOrderBy(
  sortBy: SortBy,
  sortDirection: SortDirection
): Prisma.UserOrderByWithRelationInput[] {
  const createdAtTieBreaker: Prisma.UserOrderByWithRelationInput = { createdAt: 'desc' };

  if (sortBy === 'user') {
    return [{ name: sortDirection }, { email: sortDirection }, createdAtTieBreaker];
  }

  if (sortBy === 'subscription') {
    return [{ subscriptionStatus: sortDirection }, createdAtTieBreaker];
  }

  if (sortBy === 'joinedDate') {
    return [{ createdAt: sortDirection }];
  }

  if (sortBy === 'workspacesOwned') {
    return [{ ownedWorkspaces: { _count: sortDirection } }, createdAtTieBreaker];
  }

  if (sortBy === 'projectsOwned') {
    return [{ projects: { _count: sortDirection } }, createdAtTieBreaker];
  }

  if (sortBy === 'totalComments') {
    return [{ comments: { _count: sortDirection } }, createdAtTieBreaker];
  }

  return [createdAtTieBreaker];
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sortBy?: string; sortDirection?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    redirect('/');
  }

  const resolvedSearchParams = await searchParams;
  const requestedPage = Number(resolvedSearchParams?.page) || 1;
  const sortBy: SortBy = isSortBy(resolvedSearchParams?.sortBy)
    ? resolvedSearchParams.sortBy
    : 'joinedDate';
  const sortDirection: SortDirection =
    resolvedSearchParams?.sortDirection === 'asc' || resolvedSearchParams?.sortDirection === 'desc'
      ? resolvedSearchParams.sortDirection
      : getDefaultSortDirection(sortBy);
  const pageSize = 20;
  const stripeBillingEnabled = isStripeBillingEnabled();
  const now = new Date();
  const [totalUsers, userStorage, userBunnyStorage, userDownloadEgress, bunnyStorageStats] =
    await Promise.all([
      db.user.count(),
      getCachedUserMediaStorage(),
      getCachedUserBunnyStorage(),
      getCachedUserDownloadEgress(),
      getCachedBunnyStorageStats(),
    ]);
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const skip = (page - 1) * pageSize;

  const select = {
    id: true,
    name: true,
    email: true,
    createdAt: true,
    subscriptionStatus: true,
    trialEndsAt: true,
    stripeCurrentPeriodEnd: true,
    stripeCancelAtPeriodEnd: true,
    stripeCancelAt: true,
    billingAccessEndedAt: true,
    ownedWorkspaces: {
      select: {
        _count: {
          select: {
            members: true,
          },
        },
      },
    },
    _count: {
      select: {
        ownedWorkspaces: true,
        projects: true,
        comments: true,
      },
    },
  } satisfies Prisma.UserSelect;

  let paginatedUsers: Array<{
    id: string;
    name: string | null;
    email: string | null;
    createdAt: Date;
    subscriptionStatus: BillingSubscriptionStatus;
    trialEndsAt: Date | null;
    stripeCurrentPeriodEnd: Date | null;
    stripeCancelAtPeriodEnd: boolean;
    stripeCancelAt: Date | null;
    billingAccessEndedAt: Date | null;
    ownedWorkspaces: Array<{ _count: { members: number } }>;
    _count: { ownedWorkspaces: number; projects: number; comments: number };
    invitedMembersCount: number;
    bunnyUploadBytes: number;
    downloadEgressBytes: number;
    mediaStorageBytes: number;
  }> = [];

  if (canSortInDb(sortBy)) {
    const users = await db.user.findMany({
      skip,
      take: pageSize,
      orderBy: getUsersOrderBy(sortBy, sortDirection),
      select,
    });

    paginatedUsers = users.map((user) => ({
      ...user,
      invitedMembersCount: user.ownedWorkspaces.reduce(
        (total, workspace) => total + workspace._count.members,
        0
      ),
      bunnyUploadBytes: userBunnyStorage[user.id] || 0,
      downloadEgressBytes: userDownloadEgress[user.id] || 0,
      mediaStorageBytes: userStorage[user.id]?.total || 0,
    }));
  } else {
    const users = await db.user.findMany({ select });

    const usersWithMetrics = users.map((user) => ({
      ...user,
      invitedMembersCount: user.ownedWorkspaces.reduce(
        (total, workspace) => total + workspace._count.members,
        0
      ),
      bunnyUploadBytes: userBunnyStorage[user.id] || 0,
      downloadEgressBytes: userDownloadEgress[user.id] || 0,
      mediaStorageBytes: userStorage[user.id]?.total || 0,
    }));

    const sortedUsers = usersWithMetrics.sort((a, b) => {
      let comparison = 0;

      if (sortBy === 'invitedMembers') {
        comparison = a.invitedMembersCount - b.invitedMembersCount;
      } else if (sortBy === 'bunnyUpload') {
        comparison = a.bunnyUploadBytes - b.bunnyUploadBytes;
      } else if (sortBy === 'downloadEgress') {
        comparison = a.downloadEgressBytes - b.downloadEgressBytes;
      } else if (sortBy === 'mediaStorage') {
        comparison = a.mediaStorageBytes - b.mediaStorageBytes;
      }

      if (comparison === 0) {
        comparison = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    paginatedUsers = sortedUsers.slice(skip, skip + pageSize);
  }

  // Resolve the real in-app access for each user on the current page. Access is
  // not just the user's own subscription: a user with no billing of their own
  // still has access as a collaborator on a paying owner's workspace/project
  // (mirrors hasAppNavigationAccess in lib/route-access.ts).
  const accessByUserId = new Map<string, { hasAppAccess: boolean; viaCollaboration: boolean }>();
  if (stripeBillingEnabled) {
    await Promise.all(
      paginatedUsers.map(async (user) => {
        const { ownAccess } = getOwnBillingAccess(user, now);
        const hasAppAccess = ownAccess || (await hasCollaboratorBillingBackedAccess(user.id));
        accessByUserId.set(user.id, {
          hasAppAccess,
          viaCollaboration: hasAppAccess && !ownAccess,
        });
      })
    );
  }

  const buildUsersPageHref = (
    targetPage: number,
    targetSortBy: SortBy = sortBy,
    targetSortDirection: SortDirection = sortDirection
  ): string => {
    const params = new URLSearchParams({
      page: String(targetPage),
      sortBy: targetSortBy,
      sortDirection: targetSortDirection,
    });

    return `/admin/users?${params.toString()}`;
  };

  const buildSortHref = (column: SortBy): string => {
    const nextDirection: SortDirection =
      column === sortBy
        ? sortDirection === 'asc'
          ? 'desc'
          : 'asc'
        : getDefaultSortDirection(column);

    return buildUsersPageHref(1, column, nextDirection);
  };

  return (
    <div className="flex-1 space-y-4">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Users</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Bunny Stream Storage</CardTitle>
            <Film className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isBunnyUploadsFeatureEnabled()
                ? formatBytes(bunnyStorageStats.totalBytes)
                : 'Disabled'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cloudflare R2 Media Storage</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatBytes(Object.values(userStorage).reduce((sum, item) => sum + item.total, 0))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>
            A comprehensive list of all {totalUsers} users registered on the platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Link
                      href={buildSortHref('user')}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      User
                      <span className="text-xs">
                        {getSortIndicator('user', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  {stripeBillingEnabled && (
                    <TableHead>
                      <Link
                        href={buildSortHref('subscription')}
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        Subscription
                        <span className="text-xs">
                          {getSortIndicator('subscription', sortBy, sortDirection)}
                        </span>
                      </Link>
                    </TableHead>
                  )}
                  <TableHead>
                    <Link
                      href={buildSortHref('joinedDate')}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      Joined Date
                      <span className="text-xs">
                        {getSortIndicator('joinedDate', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('workspacesOwned')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Workspaces Owned
                      <span className="text-xs">
                        {getSortIndicator('workspacesOwned', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('invitedMembers')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Invited Members
                      <span className="text-xs">
                        {getSortIndicator('invitedMembers', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('projectsOwned')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Projects Owned
                      <span className="text-xs">
                        {getSortIndicator('projectsOwned', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-center">
                    <Link
                      href={buildSortHref('totalComments')}
                      className="inline-flex items-center justify-center gap-1 hover:underline"
                    >
                      Total Comments
                      <span className="text-xs">
                        {getSortIndicator('totalComments', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">
                    <Link
                      href={buildSortHref('bunnyUpload')}
                      className="inline-flex items-center justify-end gap-1 hover:underline"
                    >
                      Bunny Upload
                      <span className="text-xs">
                        {getSortIndicator('bunnyUpload', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">
                    <Link
                      href={buildSortHref('downloadEgress')}
                      className="inline-flex items-center justify-end gap-1 hover:underline"
                    >
                      Download Egress (Est.)
                      <span className="text-xs">
                        {getSortIndicator('downloadEgress', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                  <TableHead className="text-right">
                    <Link
                      href={buildSortHref('mediaStorage')}
                      className="inline-flex items-center justify-end gap-1 hover:underline"
                    >
                      Media Storage
                      <span className="text-xs">
                        {getSortIndicator('mediaStorage', sortBy, sortDirection)}
                      </span>
                    </Link>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={stripeBillingEnabled ? 10 : 9} className="h-24 text-center">
                      No users found.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{user.name || 'Anonymous'}</span>
                          <span className="text-xs text-muted-foreground">{user.email}</span>
                        </div>
                      </TableCell>
                      {stripeBillingEnabled &&
                        (() => {
                          const { endsAt } = getOwnBillingAccess(user, now);
                          const access = accessByUserId.get(user.id) ?? {
                            hasAppAccess: false,
                            viaCollaboration: false,
                          };
                          return (
                            <TableCell>
                              <div className="flex flex-col items-start gap-1">
                                <Badge variant={getBillingStatusVariant(user.subscriptionStatus)}>
                                  {getBillingStatusLabel(user.subscriptionStatus)}
                                </Badge>
                                {access.hasAppAccess ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    Active access
                                    {access.viaCollaboration
                                      ? ' · via team'
                                      : endsAt
                                        ? ` · until ${format(new Date(endsAt), 'MMM dd')}`
                                        : ''}
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">No access</span>
                                )}
                              </div>
                            </TableCell>
                          );
                        })()}
                      <TableCell>{format(new Date(user.createdAt), 'MMM dd, yyyy')}</TableCell>
                      <TableCell className="text-center">{user._count.ownedWorkspaces}</TableCell>
                      <TableCell className="text-center">{user.invitedMembersCount}</TableCell>
                      <TableCell className="text-center">{user._count.projects}</TableCell>
                      <TableCell className="text-center">{user._count.comments}</TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {formatBytes(user.bunnyUploadBytes)}
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {formatBytes(user.downloadEgressBytes)}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        <div className="flex flex-col items-end">
                          <span className="font-medium text-foreground">
                            {formatBytes(user.mediaStorageBytes)}
                          </span>
                          {(userStorage[user.id]?.voice > 0 || userStorage[user.id]?.image > 0) && (
                            <span className="text-xs text-muted-foreground mt-0.5 whitespace-nowrap space-x-1">
                              {userStorage[user.id]?.voice > 0 && (
                                <span>🎤 {formatBytes(userStorage[user.id]?.voice)}</span>
                              )}
                              {userStorage[user.id]?.voice > 0 &&
                                userStorage[user.id]?.image > 0 && <span>•</span>}
                              {userStorage[user.id]?.image > 0 && (
                                <span>🖼️ {formatBytes(userStorage[user.id]?.image)}</span>
                              )}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-end space-x-2 py-4">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? <Link href={buildUsersPageHref(page - 1)}>Previous</Link> : 'Previous'}
              </Button>
              <span className="text-sm font-medium">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                asChild={page < totalPages}
              >
                {page < totalPages ? <Link href={buildUsersPageHref(page + 1)}>Next</Link> : 'Next'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
