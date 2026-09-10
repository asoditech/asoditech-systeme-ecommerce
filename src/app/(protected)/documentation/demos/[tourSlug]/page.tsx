import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { GuidedTourViewer } from "@/components/docs/guided-tour-viewer";
import { requireUser } from "@/lib/auth/guards";
import { GUIDED_TOURS, getGuidedTour } from "@/lib/docs/guided-tours";

export async function generateStaticParams() {
  return GUIDED_TOURS.map((t) => ({ tourSlug: t.slug }));
}

export default async function DocDemoPage({ params }: { params: Promise<{ tourSlug: string }> }) {
  await requireUser();
  const { tourSlug } = await params;
  const tour = getGuidedTour(tourSlug);
  if (!tour) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tour.title}
        description={tour.tagline}
        breadcrumbs={[{ label: "Documentation", href: "/documentation" }, { label: tour.title }]}
      />
      <GuidedTourViewer tour={tour} />
    </div>
  );
}
