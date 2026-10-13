"use client";

import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Copy, MoreHorizontal, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DateRangeFields } from "@/components/date-range-fields";
import { DateRangeFilter } from "@/components/date-range-filter";
import { FilterSelect } from "@/components/filter-select";

const CITIES: Record<string, string> = { casa: "Casablanca", rabat: "Rabat", fes: "Fès" };

/** The client-side half of the /dev/components gallery (overlays, Base UI controls). */
export function InteractiveDemos({ id }: { id: string }) {
  const [city, setCity] = useState("casa");
  const [notify, setNotify] = useState(true);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4">
          <Field className="w-56">
            <Label>Select (Base UI)</Label>
            <Select value={city} onValueChange={(v) => v && setCity(v)}>
              <SelectTrigger className="w-full" aria-label="Ville">
                <SelectValue>{(v: string) => CITIES[v] ?? v}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CITIES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <Label>Filtre de liste</Label>
            <Suspense>
              <FilterSelect
                paramKey={`demo-${id}`}
                allLabel="Tous les statuts"
                ariaLabel="Statut"
                className="w-52"
                options={[
                  { value: "NOUVELLE", label: "Nouvelle" },
                  { value: "LIVREE", label: "Livrée" },
                ]}
              />
            </Suspense>
          </Field>
          <Field>
            <Label>Du / Au</Label>
            <DateRangeFields idPrefix={`${id}-range`} from="2026-10-01" to="2026-10-13" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <DateRangeFilter basePath="/dev/components" initialRange="this-month" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-6">
          <Tabs defaultValue="all">
            <TabsList>
              <TabsTrigger value="all">Toutes</TabsTrigger>
              <TabsTrigger value="todo">À confirmer</TabsTrigger>
              <TabsTrigger value="done">Livrées</TabsTrigger>
            </TabsList>
            <TabsContent value="all" className="text-ink-secondary">
              Onglets « ligne » (style par défaut du projet).
            </TabsContent>
            <TabsContent value="todo" className="text-ink-secondary">
              12 commandes à confirmer.
            </TabsContent>
            <TabsContent value="done" className="text-ink-secondary">
              Historique des livraisons.
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="week">
            <TabsList variant="default">
              <TabsTrigger value="week">Semaine</TabsTrigger>
              <TabsTrigger value="month">Mois</TabsTrigger>
              <TabsTrigger value="year">Année</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <Checkbox defaultChecked /> Coché
            </label>
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <Checkbox /> Non coché
            </label>
            <label className="flex items-center gap-2.5 text-sm text-ink-muted">
              <Checkbox disabled /> Désactivé
            </label>
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <Switch checked={notify} onCheckedChange={setNotify} /> Notifications
            </label>
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <Switch /> Inactif
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <MoreHorizontal data-icon="inline-start" />
              Menu
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Commande</DropdownMenuLabel>
                <DropdownMenuItem>
                  <Copy /> Dupliquer
                </DropdownMenuItem>
                <DropdownMenuItem>Imprimer l&apos;étiquette</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <Trash2 /> Supprimer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>Dialogue</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Modifier l&apos;adresse</DialogTitle>
                <DialogDescription>Adresse de livraison de CMD-000017.</DialogDescription>
              </DialogHeader>
              <DialogBody>
                <Field>
                  <Label htmlFor={`${id}-addr`}>Adresse</Label>
                  <Input id={`${id}-addr`} defaultValue="12 rue Ibn Battouta" />
                </Field>
              </DialogBody>
              <DialogFooter>
                <Button variant="outline">Annuler</Button>
                <Button>Enregistrer</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" />}>Confirmation</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Annuler la commande ?</AlertDialogTitle>
                <AlertDialogDescription>Le stock réservé sera libéré.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Retour</AlertDialogCancel>
                <AlertDialogAction variant="destructive">Annuler la commande</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>Tiroir</SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Détails du colis</SheetTitle>
                <SheetDescription>Suivi Ozon Express · 3 événements.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>

          <Popover>
            <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
            <PopoverContent>
              <p className="font-medium text-ink">Filtres avancés</p>
              <p className="mt-1 text-ink-secondary">Contenu flottant léger.</p>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" />}>Infobulle</TooltipTrigger>
            <TooltipContent>Copier la référence</TooltipContent>
          </Tooltip>

          <Button variant="secondary" onClick={() => toast.success("Commande confirmée", { description: "CMD-000017 · stock réservé." })}>
            Toast succès
          </Button>
          <Button variant="secondary" onClick={() => toast.error("Échec de synchronisation", { description: "WooCommerce ne répond pas." })}>
            Toast erreur
          </Button>
          <Button variant="secondary" onClick={() => toast("Export prêt")}>
            Toast simple
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
