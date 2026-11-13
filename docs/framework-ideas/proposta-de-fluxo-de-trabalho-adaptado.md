# Fluxo adaptado para uma estrutura de multi agentes

1. Produtor define uma necessidade qualquer. Pode ser uma nova feature, um novo projeto, bug fixing, uma analise de dados, uma pesquisa, resumo de varios documentos ou tarefa repetitiva que vai usar varios agentes.

2. Autor recebe a necessidade do produtor e monta um plano de ação detalhado que atenda a necessidade do Produtor.

3. Revisor recebe o plano de ação do Autor e revisa ela. Se tiver algum problema ela volta para o Autor corrigir, senão segue pro roteirista.

4. Roteirista recebe o plano revisado do Revisor e prepara ele para ser trabalhado. Define a sua complexidade e em quantas demandas ele será dividido e quais podem ser executadas em paralelo.

5. Diretor recebe o roteiro (demandas) e separa o elenco de atores que vão trabalhar nelas e acompanha os atores durante o seu trabalho. Cada Ator trabalha independente, mas o trabalho conjunto de todos define a entrega.

6. O Critico olha o trabalho conjunto dos Atores e compara com o roteiro e a obra revisada e emite uma analise do que foi entregue pelos Atores.

7. O Diretor recebe a critica e aciona a equipe para executar as correções no caso de uma critica negativa ou em caso positivo procede para encerramento da peça. No encerramento da peça o Diretor tem total liberdade de PR e merge do que foi realizado.

8. No caso de correções o Diretor pode proceder conforme o tipo de problema encontrado:

    * Se o problema for da execução dos Atores, retorna ao passo 5 para ser corrigido.
      
    * Se o problema for do roteiro, retorna ao passo 4 para o roteirista corrigir e a correção deve ser revisada pelo Autor. Se as correções forem aprovadas, elas retornam para o Diretor, para execução.
      
    *  Se for um problema estrutural do plano de ação do Autor, retorna aos passos 1 e 2 para o Autor corrigir, com revisão do Revisor e depois volta ao Roteirista e assim por diante.
  
9. Volta para o passo 1 para a proxima necessidade do Produtor.
