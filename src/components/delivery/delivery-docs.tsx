import { HelpCircle, Workflow } from "lucide-react";
import { Notice } from "@/components/ui/notice";

/**
 * The Livraison → « Documentation » tab. Plain-French, non-technical
 * guides — one overview of how orders / boutique / carrier connect, then
 * one collapsible section per delivery company (OzonExpress, Sendit, Ameex; add
 * another `<CarrierGuide>` block as more are onboarded). Native
 * <details>, no JS, works in an RSC.
 */
export function DeliveryDocs() {
  return (
    <div className="space-y-4">
      <FlowOverview />
      <OzonExpressGuide />
      <SenditGuide />
      <AmeexGuide />
    </div>
  );
}

function FlowOverview() {
  return (
    <section className="rounded-card bg-card p-5 text-sm shadow-card">
      <h2 className="flex items-center gap-2 font-medium">
        <Workflow className="size-4" />
        Comment tout se connecte : commande → boutique → livraison
      </h2>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <p>
          Trois systèmes travaillent ensemble : votre <span className="text-foreground">boutique</span> (WooCommerce ou
          Shopify), <span className="text-foreground">ce projet</span> (ASODITECH), et la{" "}
          <span className="text-foreground">société de livraison</span> (aujourd&apos;hui : OzonExpress, Sendit ou Ameex).
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
              Vous faites avancer la commande ici : Nouvelle → Confirmée → Emballage → Expédiée. Le stock est
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
              La société de livraison met à jour le statut du colis (ramassé, en transit, livré, retourné…). Ce statut
              n&apos;arrive pas tout seul : rafraîchissez-le depuis l&apos;expédition, « Rafraîchir les statuts » ou
              l&apos;onglet Suivi.
            </li>
            <li>
              Quand le colis passe <span className="text-foreground">en transit</span> ou{" "}
              <span className="text-foreground">livré</span> → une commande encore « Confirmée » ou « En préparation »
              passe d&apos;abord « Expédiée » (le stock est déduit une seule fois), puis « Livrée » ici{" "}
              <span className="text-foreground">et</span> « Terminée » sur votre boutique WooCommerce.
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
            Les statuts des colis sont récupérés auprès du transporteur quand vous cliquez sur « Rafraîchir les statuts » ou
            « Actualiser le suivi » — ils ne se mettent pas à jour tout seuls.
          </p>
        </div>
      </div>
    </section>
  );
}

function OzonExpressGuide() {
  return (
    <details className="rounded-card bg-card p-5 text-sm shadow-card [&_summary]:cursor-pointer">
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
            Quand un rafraîchissement trouve un colis <span className="text-foreground">livré</span> chez OzonExpress,
            la commande passe à « Livrée » ici (via « Expédiée » si elle ne l&apos;était pas encore) — et sur votre
            boutique WooCommerce à « Terminée ». Le statut n&apos;est pas poussé par OzonExpress : utilisez
            «&nbsp;Rafraîchir le statut&nbsp;» sur une expédition ou « Rafraîchir les statuts ».
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

function SenditGuide() {
  return (
    <details className="rounded-card bg-card p-5 text-sm shadow-card [&_summary]:cursor-pointer">
      <summary className="flex items-center gap-2 font-medium">
        <HelpCircle className="size-4" />
        Guide : Sendit
      </summary>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <Notice tone="warning" className="block">
          Connecteur Sendit disponible mais pas encore validé sur un compte réel. Il a été construit à partir de la
          documentation officielle de l&apos;API Sendit ; testez d&apos;abord avec une vraie commande avant de
          l&apos;utiliser en production.
        </Notice>

        <section className="space-y-1">
          <p className="font-medium text-foreground">1. Obtenir vos clés API</p>
          <p>
            Dans votre compte Sendit, ouvrez la rubrique API / Intégrations (ou demandez l&apos;accès API à votre
            interlocuteur Sendit). Vous obtenez deux valeurs : une <span className="text-foreground">clé publique</span>{" "}
            (public_key) et une <span className="text-foreground">clé secrète</span> (secret_key). Gardez la clé secrète
            pour vous : elle n&apos;est jamais réaffichée ici après l&apos;enregistrement.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">2. Connecter Sendit à ce projet</p>
          <p>
            Onglet « Prestataires » → créez un prestataire de type « API », choisissez le connecteur « Sendit (Maroc) »,
            collez la clé publique et la clé secrète, puis cliquez sur{" "}
            <span className="text-foreground">« Tester la connexion »</span>. Le test se contente de se connecter à
            Sendit avec vos clés — il ne crée aucun colis. Le statut passe à « Connecté » uniquement si le test réussit.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">3. Créer les colis</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Dans l&apos;onglet « À expédier », choisissez Sendit pour une commande : le projet crée le colis chez
              Sendit et récupère son code (qui sert de numéro de suivi) et les frais de livraison indiqués par Sendit.
            </li>
            <li>
              Pour l&apos;instant, seules les commandes en{" "}
              <span className="text-foreground">paiement à la livraison</span> sont envoyées : la documentation Sendit
              ne précise pas le montant à déclarer pour un colis déjà payé.
            </li>
            <li>
              Si Sendit ne répond pas clairement pendant la création, l&apos;expédition est marquée « à vérifier » et
              aucune nouvelle tentative n&apos;est faite automatiquement : vérifiez sur le portail Sendit avant de
              réessayer, pour ne pas créer le colis deux fois.
            </li>
          </ul>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">4. Correspondance des villes</p>
          <p>
            Sendit identifie chaque destination (ville ou quartier) par un numéro. Le projet fait la correspondance à
            partir de la liste des villes Sendit. Si une ville de commande n&apos;est pas reconnue, ajoutez une
            correspondance précise depuis « Correspondances de villes » — sinon aucun colis n&apos;est envoyé.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">5. Étiquettes</p>
          <p>
            Le bouton « Étiquette » d&apos;une expédition Sendit demande l&apos;étiquette à Sendit au moment du clic et
            l&apos;ouvre dans votre navigateur. Le lien fourni par Sendit est temporaire : il n&apos;est pas conservé ici.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">6. Suivi &amp; statuts (provisoires)</p>
          <p>
            Sendit n&apos;envoie pas les changements de statut tout seul : utilisez « Rafraîchir le statut » sur une
            expédition, « Rafraîchir les statuts » ou l&apos;onglet Suivi. La traduction des statuts Sendit (« Ramassé »,
            « En transit », « Livré », « Refusé »…) vers les statuts de ce projet est{" "}
            <span className="text-foreground">provisoire</span> tant qu&apos;elle n&apos;a pas été vérifiée sur de vrais
            colis ; le statut d&apos;origine envoyé par Sendit est toujours conservé.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">7. Ce qui n&apos;est pas encore disponible</p>
          <p>
            L&apos;annulation d&apos;un colis depuis ce projet, la modification d&apos;un colis déjà créé et les
            bordereaux de remise ne sont pas proposés pour Sendit : faites-les depuis le portail Sendit.
          </p>
        </section>
      </div>
    </details>
  );
}

function AmeexGuide() {
  return (
    <details className="rounded-card bg-card p-5 text-sm shadow-card [&_summary]:cursor-pointer">
      <summary className="flex items-center gap-2 font-medium">
        <HelpCircle className="size-4" />
        Guide : Ameex
      </summary>

      <div className="mt-3 space-y-4 text-muted-foreground">
        <Notice tone="warning" className="block">
          Connecteur Ameex validé sur le <span className="font-medium">bac à sable</span> Ameex uniquement (colis
          fictifs, octobre 2026) — pas encore sur un compte de production. Faites un premier essai avec une vraie
          commande et vérifiez-la sur le portail Ameex avant de l&apos;utiliser au quotidien.
        </Notice>

        <section className="space-y-1">
          <p className="font-medium text-foreground">1. Obtenir vos identifiants API</p>
          <p>
            Dans votre espace Ameex, ouvrez la rubrique <span className="text-foreground">« Développeur / API »</span>.
            Vous y trouvez deux valeurs : l&apos;<span className="text-foreground">API Id</span> et la{" "}
            <span className="text-foreground">clé API</span>. Une clé qui commence par « test_ » est une clé de{" "}
            <span className="text-foreground">bac à sable</span> : les colis créés avec elle sont fictifs (code « SBX-… »)
            et ne sont jamais livrés. Toute autre clé est une clé de production. La clé n&apos;est jamais réaffichée ici
            après l&apos;enregistrement.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">2. Connecter Ameex à ce projet</p>
          <p>
            Onglet « Prestataires » → créez un prestataire de type « API », choisissez le connecteur « Ameex (Maroc) »,
            collez l&apos;API Id et la clé API, puis cliquez sur{" "}
            <span className="text-foreground">« Tester la connexion »</span>. Le test lit seulement la liste des statuts
            Ameex — il ne crée aucun colis. Le statut passe à « Connecté » uniquement si le test réussit.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">3. Mises à jour automatiques (webhook)</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Choisissez un <span className="text-foreground">secret de signature</span> (une longue phrase aléatoire),
              saisissez-le chez Ameex dans la configuration du webhook, et le même dans le champ « Secret de signature
              des webhooks Ameex » de ce prestataire.
            </li>
            <li>
              Adresse à coller chez Ameex :{" "}
              <span className="font-mono text-foreground">
                https://&lt;votre domaine&gt;/api/webhooks/delivery/&lt;identifiant de la connexion&gt;
              </span>{" "}
              — une adresse par connexion, affichée toute prête dans « Configurer » de ce prestataire (champ « URL du
              webhook à coller chez le transporteur »).
            </li>
            <li>
              Sans secret, Ameex envoie des webhooks non signés : ils sont toujours refusés. Un webhook ne fait que
              déclencher une relecture du statut chez Ameex ; rien n&apos;est appliqué sur la seule foi de son contenu.
            </li>
          </ul>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">4. Créer les colis</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              Dans l&apos;onglet « À expédier », choisissez Ameex pour une commande : le projet crée le colis chez Ameex
              (destinataire, téléphone, ville, adresse, montant à encaisser, articles, note, n° de commande) et récupère
              son code, qui sert de numéro de suivi.
            </li>
            <li>
              Une commande déjà payée est envoyée avec un montant à encaisser de 0 — ce cas n&apos;a pas encore été
              vérifié chez Ameex.
            </li>
            <li>
              Si Ameex ne répond pas clairement pendant la création, l&apos;expédition est marquée « à vérifier » et
              aucune nouvelle tentative n&apos;est faite automatiquement : vérifiez sur le portail Ameex avant de
              réessayer, pour ne pas créer le colis deux fois.
            </li>
          </ul>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">5. Correspondance des villes</p>
          <p>
            Ameex identifie chaque ville par un numéro. Le projet fait la correspondance à partir de la liste des villes
            Ameex. Si une ville de commande n&apos;est pas reconnue, ajoutez une correspondance précise depuis
            « Correspondances de villes » — sinon aucun colis n&apos;est envoyé.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">6. Suivi &amp; statuts (provisoires)</p>
          <p>
            Les statuts arrivent par le webhook, ou à la demande avec « Rafraîchir le statut », « Rafraîchir les
            statuts » ou l&apos;onglet Suivi (historique complet). La traduction des statuts Ameex (« Ramassé », « En
            Voyage », « Livré », « Refusé », « Retourné »…) vers les statuts de ce projet est{" "}
            <span className="text-foreground">provisoire</span> tant qu&apos;elle n&apos;a pas été vérifiée sur de vrais
            colis. « Remboursé » n&apos;est volontairement pas traduit. Le statut d&apos;origine envoyé par Ameex est
            toujours conservé.
          </p>
        </section>

        <section className="space-y-1">
          <p className="font-medium text-foreground">7. Ce qui n&apos;est pas encore disponible</p>
          <p>
            L&apos;annulation d&apos;un colis, les étiquettes, les bordereaux et les frais de livraison ne sont pas
            proposés pour Ameex (non documentés par Ameex) : faites-les depuis le portail Ameex.
          </p>
        </section>
      </div>
    </details>
  );
}
