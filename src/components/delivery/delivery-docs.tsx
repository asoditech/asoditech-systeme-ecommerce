import { HelpCircle, Workflow } from "lucide-react";

/**
 * The Livraison → « Documentation » tab. Plain-French, non-technical
 * guides — one overview of how orders / boutique / carrier connect, then
 * one collapsible section per delivery company (OzonExpress today; add
 * another `<CarrierGuide>` block as more are onboarded). Native
 * <details>, no JS, works in an RSC.
 */
export function DeliveryDocs() {
  return (
    <div className="space-y-4">
      <FlowOverview />
      <OzonExpressGuide />
    </div>
  );
}

function FlowOverview() {
  return (
    <section className="rounded-lg border p-4 text-sm">
      <h2 className="flex items-center gap-2 font-medium">
        <Workflow className="size-4" />
        Comment tout se connecte : commande → boutique → livraison
      </h2>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <p>
          Trois systèmes travaillent ensemble : votre <span className="text-foreground">boutique</span> (WooCommerce ou
          Shopify), <span className="text-foreground">ce projet</span> (ASODITECH), et la{" "}
          <span className="text-foreground">société de livraison</span> (aujourd&apos;hui : OzonExpress).
        </p>

        <div className="space-y-2">
          <p className="font-medium text-foreground">1. La commande arrive</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Un client commande sur votre <span className="text-foreground">boutique</span> → la commande est
              importée ici automatiquement (webhook temps réel), avec le client, l&apos;adresse et les articles.
            </li>
            <li>
              Ou vous créez la commande <span className="text-foreground">manuellement</span> ici (Nouvelle commande),
              en indiquant son canal (WhatsApp, téléphone…).
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <p className="font-medium text-foreground">2. Préparation &amp; expédition</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Vous faites avancer la commande ici : Nouvelle → Confirmée → En préparation → Expédiée. Le stock est
              réservé à la création, puis déduit à l&apos;expédition.
            </li>
            <li>
              Dans l&apos;onglet <span className="text-foreground">« À expédier »</span>, vous créez l&apos;expédition
              chez la société de livraison — soit ce projet crée le colis via l&apos;API, soit la boutique l&apos;a
              déjà créé (voir le guide OzonExpress ci-dessous).
            </li>
            <li>
              Le numéro de suivi de la société de livraison remonte alors dans la colonne « Suivi » de l&apos;onglet
              « Expéditions ».
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <p className="font-medium text-foreground">3. Suivi &amp; retour d&apos;information</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              La société de livraison met à jour le statut du colis (ramassé, en transit, livré, retourné…). Vous
              rafraîchissez ce statut depuis l&apos;expédition, ou il est mis à jour automatiquement.
            </li>
            <li>
              Quand le colis passe <span className="text-foreground">livré</span> → la commande passe automatiquement
              « Livrée » ici <span className="text-foreground">et</span> « Terminée » sur votre boutique WooCommerce.
              Une annulation ici est aussi répercutée sur la boutique.
            </li>
            <li>
              Le stock est repoussé vers la boutique à chaque changement (vente, retour, ajustement manuel), pour que
              les quantités affichées au client restent justes.
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <p className="font-medium text-foreground">En résumé</p>
          <p>
            La <span className="text-foreground">boutique</span> est le canal de vente. <span className="text-foreground">Ce projet</span>{" "}
            est le poste de pilotage : c&apos;est ici qu&apos;on gère les commandes, le stock et les expéditions. La{" "}
            <span className="text-foreground">société de livraison</span> transporte les colis et renvoie leur statut.
            Les changements importants circulent automatiquement dans les deux sens.
          </p>
        </div>
      </div>
    </section>
  );
}

function OzonExpressGuide() {
  return (
    <details className="rounded-lg border bg-muted/30 p-4 text-sm [&_summary]:cursor-pointer">
      <summary className="flex items-center gap-2 font-medium">
        <HelpCircle className="size-4" />
        Guide : OzonExpress
      </summary>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <section className="space-y-1">
          <p className="font-medium text-foreground">1. Obtenir vos identifiants</p>
          <p>
            Dans votre compte OzonExpress : <span className="text-foreground">Compte → « Generate your API key »</span>. Vous
            obtenez deux valeurs : votre <span className="text-foreground">identifiant client</span> et votre{" "}
            <span className="text-foreground">clé API</span>.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">2. Connecter OzonExpress à ce projet</p>
          <p>
            Onglet « Prestataires » → créez un prestataire de type « API », choisissez le connecteur « OzonExpress »,
            collez l&apos;identifiant client et la clé API, puis cliquez sur{" "}
            <span className="text-foreground">« Tester la connexion »</span>. Le statut passe à « Connecté » uniquement
            si le test réussit.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">3. Deux façons de créer les colis</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <span className="text-foreground">Création par ce projet (par défaut)</span> : dans l&apos;onglet « À
              expédier », choisissez OzonExpress pour une commande — le projet crée le colis chez OzonExpress et
              récupère le numéro de suivi automatiquement.
            </li>
            <li>
              <span className="text-foreground">Création par la boutique</span> : si votre site possède déjà un module
              qui crée le colis OzonExpress à la commande, activez l&apos;option «&nbsp;Les colis sont créés par la
              boutique&nbsp;» sur ce prestataire. Le projet ne créera plus de colis en double — vous utilisez « Créer
              une expédition » et saisissez le numéro de suivi fourni par OzonExpress.
            </li>
          </ul>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">4. Correspondance des villes</p>
          <p>
            OzonExpress identifie les villes par un numéro. Le projet fait la correspondance automatiquement à partir de
            la liste des villes d&apos;OzonExpress. Si une ville de commande n&apos;est pas reconnue (orthographe
            différente), ajoutez une correspondance précise depuis « Correspondances de villes ».
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">5. Suivi &amp; statuts</p>
          <p>
            Le numéro de suivi et son lien apparaissent dans la colonne « Suivi » de l&apos;onglet « Expéditions ».
            Quand OzonExpress marque un colis <span className="text-foreground">livré</span>, la commande passe
            automatiquement à « Livrée » ici — et sur votre boutique WooCommerce à « Terminée ». Utilisez
            «&nbsp;Rafraîchir le statut&nbsp;» sur une expédition pour forcer la mise à jour depuis OzonExpress.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">6. Bon de livraison (remise au transporteur)</p>
          <p>
            L&apos;onglet « Bons de livraison » regroupe plusieurs colis « En attente » d&apos;un même transporteur sur
            un bordereau. Une fois généré, le bordereau et les étiquettes s&apos;ouvrent sur le portail OzonExpress où
            vous êtes déjà connecté.
          </p>
        </section>
      </div>
    </details>
  );
}
