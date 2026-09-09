import { HelpCircle, Workflow } from "lucide-react";

/**
 * The Livraison → « Documentation » tab. Plain-French, non-technical
 * guides — one overview of how orders / boutique / carrier connect, then
 * one collapsible section per delivery company (OzonExpress, Aramex; add
 * another `<CarrierGuide>` block as more are onboarded). Native
 * <details>, no JS, works in an RSC.
 */
export function DeliveryDocs() {
  return (
    <div className="space-y-4">
      <FlowOverview />
      <OzonExpressGuide />
      <AramexGuide />
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
          <span className="text-foreground">société de livraison</span> (aujourd&apos;hui : OzonExpress ou Aramex).
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

function AramexGuide() {
  return (
    <details className="rounded-lg border bg-muted/30 p-4 text-sm [&_summary]:cursor-pointer">
      <summary className="flex items-center gap-2 font-medium">
        <HelpCircle className="size-4" />
        Guide : Aramex
      </summary>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <p className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          Connecteur Aramex disponible mais pas encore validé sur un compte réel. Les points de terminaison proviennent
          de la documentation officielle Aramex ; testez d&apos;abord avec une commande réelle avant de l&apos;utiliser en
          production.
        </p>

        <section className="space-y-1">
          <p className="font-medium text-foreground">1. Obtenir vos accès API</p>
          <p>
            Aramex n&apos;active pas l&apos;API par défaut. Depuis votre compte marchand Aramex, faites une demande
            «&nbsp;Aramex API tools&nbsp;» (ou contactez votre agence). Aramex vous fournit six valeurs :{" "}
            <span className="text-foreground">nom d&apos;utilisateur</span> (e-mail),{" "}
            <span className="text-foreground">mot de passe API</span>,{" "}
            <span className="text-foreground">numéro de compte</span>,{" "}
            <span className="text-foreground">code PIN</span>,{" "}
            <span className="text-foreground">entité</span> (code à 3 lettres de l&apos;agence d&apos;origine, ex.{" "}
            <span className="text-foreground">CMN</span> pour Casablanca) et{" "}
            <span className="text-foreground">code pays</span> (ex. <span className="text-foreground">MA</span>).
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">2. Connecter Aramex à ce projet</p>
          <p>
            Onglet « Prestataires » → créez un prestataire de type « API », choisissez le connecteur « Aramex », collez
            les six valeurs, puis cliquez sur <span className="text-foreground">« Tester la connexion »</span>. Le test
            interroge le suivi Aramex avec un numéro fictif — il ne crée aucun envoi — et confirme uniquement que les
            identifiants sont acceptés.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">3. Renseigner l&apos;adresse d&apos;expédition</p>
          <p>
            Aramex exige une adresse d&apos;origine complète sur chaque envoi. Dans le champ{" "}
            <span className="text-foreground">Configuration (JSON)</span> du prestataire, indiquez au minimum :
          </p>
          <pre className="overflow-x-auto rounded-md border bg-background p-2 text-xs text-foreground">
{`{
  "shipperName": "Votre société",
  "shipperPhone": "0522000000",
  "shipperLine1": "12 Rue de l'Industrie",
  "shipperCity": "Casablanca",
  "shipperCountryCode": "MA",
  "productGroup": "DOM",
  "productType": "OND",
  "paymentType": "P",
  "defaultWeightKg": 0.5,
  "defaultGoodsDescription": "Vêtements",
  "sandbox": true
}`}
          </pre>
          <p>
            <span className="text-foreground">productType « OND »</span> est le type domestique avec paiement à la
            livraison (COD). Le montant à encaisser est repris automatiquement depuis la commande.
          </p>
          <p>
            Gardez <span className="text-foreground">&quot;sandbox&quot;: true</span> pour tester tout le flux sur
            l&apos;environnement d&apos;essai d&apos;Aramex (<span className="font-mono">ws.dev.aramex.net</span>), puis
            passez à <span className="text-foreground">false</span> (ou retirez la ligne) une fois vos identifiants de
            production Aramex Maroc obtenus.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">4. Créer les envois</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <span className="text-foreground">Création par ce projet (par défaut)</span> : dans l&apos;onglet « À
              expédier », choisissez Aramex pour une commande — le projet crée l&apos;envoi (AWB) chez Aramex, récupère
              le numéro de suivi et le lien de suivi, et estime le coût via le calculateur de tarifs Aramex.
            </li>
            <li>
              <span className="text-foreground">Création par la boutique</span> : si votre site crée déjà l&apos;AWB
              Aramex à la commande, activez «&nbsp;<span className="text-foreground">parcelsCreatedByStore</span>: true&nbsp;»
              dans la configuration. Vous utilisez alors « Créer une expédition » et saisissez le numéro AWB fourni par
              Aramex.
            </li>
          </ul>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">5. Villes &amp; adresses</p>
          <p>
            Contrairement à OzonExpress, Aramex n&apos;utilise pas d&apos;identifiant de ville : la ville de la commande
            et le code pays sont envoyés tels quels. Aucune « correspondance de villes » n&apos;est nécessaire.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">6. Suivi &amp; statuts</p>
          <p>
            Le numéro AWB et son lien de suivi apparaissent dans la colonne « Suivi » de l&apos;onglet « Expéditions ».
            «&nbsp;Rafraîchir le statut&nbsp;» interroge le suivi Aramex ; quand Aramex marque l&apos;envoi{" "}
            <span className="text-foreground">livré</span>, la commande passe automatiquement à « Livrée » ici. Le
            vocabulaire de statuts Aramex est encore indicatif tant qu&apos;un envoi réel n&apos;a pas été suivi de bout
            en bout.
          </p>
        </section>
      </div>
    </details>
  );
}
